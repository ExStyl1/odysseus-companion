/**
 * Global Session Store — the final ID-first session storage facade (W4 seed, W5 cutover).
 *
 * Sessions are Nessy-owned and stored globally at
 * `SESSIONS_DIR/<workspaceId>/<sessionId>/session.jsonl`, partitioned by immutable
 * Workspace ID rather than a Workspace-relative path. W5a finalized the `SessionStore`
 * interface name; wiring the production bootstrap/startup consumer onto this store is
 * completed by later W5 stages (SessionManager cutover in stage c). As of stage d,
 * `./storage.ts` is fully ID-first — the legacy `workspaceRootPath`-first helpers and
 * their SessionManager/Pi consumers have all been converted.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync,
  readFileSync, readdirSync,
  renameSync, rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { StoredMessage } from '@nessy-agent/core/types';
import {
  CONFIG_DIR,
  assertStorageId,
  getSessionStoragePath,
  getWorkspaceRootPath,
  getWorkspaceSessionRootPath,
  isPathWithin,
  resolveContainedPath,
} from '../workspaces/paths.ts';
import type { VerifiedStorageLayoutV2 } from '../workspaces/storage-readiness.ts';
import { expandPath } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { summarizeSessionOutput } from './session-activity-summary.ts';
import type {
  SessionConfig,
  SessionHeader,
  SessionKey,
  SessionMetadata,
  SessionTokenUsage,
  StoredSession,
} from './types.ts';
import { normalizeHeaderPermissionModes } from './jsonl.ts'; // F1.1234: the one header-mode reader
const SESSION_FILE_NAME = 'session.jsonl';

export interface CreateSessionOptions {
  /** Explicit session ID (e.g. for "get or create by ID" flows). Auto-generated when omitted. */
  sessionId?: string;
  name?: string;
  /** External project working directory. Rejected if it resolves inside managed storage. */
  workingDirectory?: string;
  permissionMode?: SessionConfig['permissionMode'];
  enabledSourceSlugs?: string[];
  model?: string;
  llmConnection?: string;
  hidden?: boolean;
  sessionStatus?: SessionConfig['sessionStatus'];
  labels?: string[];
  isFlagged?: boolean;
  branchFrom?: SessionConfig['branchFrom'];
  /** Runtime-only session: create contained directories but no persistent record. */
  ephemeral?: boolean;
}

/**
 * The final ID-first session store facade (W5). Every operation is addressed by an
 * immutable Workspace ID or a composite `SessionKey`; no method accepts a
 * `workspaceRootPath` or any other managed filesystem path.
 */
export interface SessionStore {
  ensureWorkspaceDir(workspaceId: string): string;
  getSessionPath(key: SessionKey): string;
  getSessionFilePath(key: SessionKey): string;
  create(workspaceId: string, options?: CreateSessionOptions): Promise<SessionConfig>;
  load(key: SessionKey): StoredSession | null;
  list(workspaceId: string): SessionMetadata[];
  delete(key: SessionKey): boolean;
}

function emptyTokenUsage(): SessionTokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 };
}

/** Rejects an explicit workingDirectory that resolves inside Nessy-managed storage. */
function assertExternalWorkingDirectory(workingDirectory: string | undefined): void {
  if (workingDirectory === undefined) return;
  if (isPathWithin(CONFIG_DIR, workingDirectory)) {
    throw new Error('workingDirectory must be an external project path, not managed storage');
  }
}

function sessionDirFor(key: SessionKey): string {
  return getSessionStoragePath(key.workspaceId, key.sessionId);
}

function sessionFileFor(key: SessionKey): string {
  return join(sessionDirFor(key), SESSION_FILE_NAME);
}

function lastMessageRoleOf(messages: StoredMessage[]): SessionHeader['lastMessageRole'] {
  const role = messages[messages.length - 1]?.type;
  return role === 'user' || role === 'assistant' || role === 'plan' || role === 'tool' || role === 'error'
    ? role
    : undefined;
}

function lastFinalMessageIdOf(messages: StoredMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === 'assistant' && !message.isIntermediate) return message.id;
  }
  return undefined;
}

function previewOf(messages: StoredMessage[]): string | undefined {
  const firstUserMessage = messages.find(message => message.type === 'user');
  if (!firstUserMessage?.content) return undefined;
  const sanitized = firstUserMessage.content.replace(/\s+/g, ' ').trim();
  return sanitized.substring(0, 150) || undefined;
}

function toHeader(session: StoredSession): SessionHeader {
  const { messages, tokenUsage, ...config } = session;
  return {
    ...config,
    lastUsedAt: Date.now(),
    messageCount: messages.length,
    lastMessageRole: lastMessageRoleOf(messages),
    preview: previewOf(messages),
    // P6.504 · derived, never model-written — see `session-activity-summary.ts`.
    lastOutputSummary: summarizeSessionOutput(messages),
    tokenUsage,
    lastFinalMessageId: lastFinalMessageIdOf(messages),
  };
}

function writeSession(file: string, session: StoredSession): void {
  const header = toHeader(session);
  const lines = [
    JSON.stringify(header),
    ...session.messages.map(message => JSON.stringify(message)),
  ];
  const tmpFile = `${file}.tmp`;
  writeFileSync(tmpFile, `${lines.join('\n')}\n`);
  try { unlinkSync(file); } catch { /* ignore if it doesn't exist */ }
  renameSync(tmpFile, file);
}

function readHeader(file: string): SessionHeader | null {
  try {
    const content = readFileSync(file, 'utf-8');
    const firstLine = content.slice(0, content.indexOf('\n') > -1 ? content.indexOf('\n') : undefined);
    if (!firstLine) return null;
    return normalizeHeaderPermissionModes(JSON.parse(firstLine) as SessionHeader);
  } catch {
    return null;
  }
}

function readStoredSession(file: string): StoredSession | null {
  try {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const firstLine = lines[0];
    if (!firstLine) return null;
    const header = normalizeHeaderPermissionModes(JSON.parse(firstLine) as SessionHeader);
    const messages: StoredMessage[] = [];
    for (const line of lines.slice(1)) {
      try {
        messages.push(JSON.parse(line) as StoredMessage);
      } catch {
        // Corrupted/truncated line (likely a crash mid-write): skip, don't lose the rest.
      }
    }
    const { messageCount: _messageCount, lastMessageRole: _lastMessageRole, preview: _preview, lastOutputSummary: _lastOutputSummary, lastFinalMessageId: _lastFinalMessageId, tokenUsage, ...config } = header;
    // Headers persist portable (~) paths; runtime consumers need them absolute.
    return {
      ...config,
      ...(config.workingDirectory ? { workingDirectory: expandPath(config.workingDirectory) } : {}),
      ...(config.sdkCwd ? { sdkCwd: expandPath(config.sdkCwd) } : {}),
      messages,
      tokenUsage,
    } as StoredSession;
  } catch {
    return null;
  }
}

function headerToMetadata(header: SessionHeader): SessionMetadata {
  return {
    id: header.id,
    workspaceId: header.workspaceId,
    name: header.name,
    createdAt: header.createdAt,
    lastUsedAt: header.lastUsedAt,
    lastMessageAt: header.lastMessageAt,
    messageCount: header.messageCount,
    preview: header.preview,
    lastOutputSummary: header.lastOutputSummary,
    sdkSessionId: header.sdkSessionId,
    // Hand-copied like every field here: SessionManager hydrates its in-memory
    // sessions from this listing at startup, so an omission is not a display
    // gap — it drops the anchor map on restart and then persists the loss.
    sdkSessionAnchors: header.sdkSessionAnchors,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    labels: header.labels,
    permissionMode: header.permissionMode,
    previousPermissionMode: header.previousPermissionMode,
    sharedUrl: header.sharedUrl,
    sharedId: header.sharedId,
    workingDirectory: header.workingDirectory ? expandPath(header.workingDirectory) : header.workingDirectory,
    piAgentViewOutcome: header.piAgentViewOutcome,
    piExecutionObservations: header.piExecutionObservations,
    sdkCwd: header.sdkCwd ? expandPath(header.sdkCwd) : header.sdkCwd,
    lastMessageRole: header.lastMessageRole,
    model: header.model,
    llmConnection: header.llmConnection,
    connectionLocked: header.connectionLocked,
    thinkingLevel: header.thinkingLevel,
    lastReadMessageId: header.lastReadMessageId,
    lastFinalMessageId: header.lastFinalMessageId,
    hasUnread: header.hasUnread,
    tokenUsage: header.tokenUsage,
    hidden: header.hidden,
    isArchived: header.isArchived,
    archivedAt: header.archivedAt, kanbanColumn: header.kanbanColumn, ...taskSessionFieldsOf(header), // UA2.1 — hand-copied like every field here, or a restart drops the board placement; UA3.1 — the project and task fields, by name
    branchFrom: header.branchFrom,
    // Durable interaction state (R7 Task 4): must survive into the listing
    // metadata or a restart drops the pending question/prompt on the floor.
    pendingAskUser: header.pendingAskUser,
    pendingApproval: header.pendingApproval,
    // P3.312 — the worktree ledger, for the same reason and one more: the
    // session whose worktree leaks is precisely the one nobody reopens, so a
    // sweep that walks `this.sessions` was walking empty ledgers. See
    // `SessionMetadata.worktreeLeaseState`.
    worktreeLeaseState: header.worktreeLeaseState,
  };
}

function ensureWorkspaceDir(workspaceId: string): string {
  const dir = getWorkspaceSessionRootPath(assertStorageId('workspace', workspaceId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getSessionPath(key: SessionKey): string {
  return sessionDirFor(key);
}

function getSessionFilePath(key: SessionKey): string {
  return sessionFileFor(key);
}

async function create(workspaceId: string, options: CreateSessionOptions = {}): Promise<SessionConfig> {
  const id = assertStorageId('workspace', workspaceId);
  ensureWorkspaceDir(id);
  assertExternalWorkingDirectory(options.workingDirectory);

  const sessionId = options.sessionId !== undefined
    ? assertStorageId('session', options.sessionId)
    : randomUUID();

  const key: SessionKey = { workspaceId: id, sessionId };
  const sessionDir = sessionDirFor(key);
  if (existsSync(sessionDir)) {
    throw new Error('Session already exists');
  }
  mkdirSync(sessionDir, { recursive: true });

  const now = Date.now();
  // The derived session directory is the default cwd for a no-project session; an explicit
  // external workingDirectory is preserved instead and never replaced by the managed path.
  const sdkCwd = options.workingDirectory ?? sessionDir;

  const config: SessionConfig = {
    id: sessionId,
    workspaceId: id,
    createdAt: now,
    lastUsedAt: now,
    sdkCwd,
    ...(options.workingDirectory !== undefined ? { workingDirectory: options.workingDirectory } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    ...(options.enabledSourceSlugs !== undefined ? { enabledSourceSlugs: options.enabledSourceSlugs } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.llmConnection !== undefined ? { llmConnection: options.llmConnection } : {}),
    ...(options.hidden !== undefined ? { hidden: options.hidden } : {}),
    ...(options.sessionStatus !== undefined ? { sessionStatus: options.sessionStatus } : {}),
    ...(options.labels !== undefined ? { labels: options.labels } : {}),
    ...(options.isFlagged !== undefined ? { isFlagged: options.isFlagged } : {}),
    ...(options.branchFrom !== undefined ? { branchFrom: options.branchFrom } : {}), ...taskSessionFieldsOf(options), // UA3.1 — copied by name (taskSessionFieldsOf)
  };

  if (!options.ephemeral) {
    const stored: StoredSession = { ...config, messages: [], tokenUsage: emptyTokenUsage() };
    writeSession(sessionFileFor(key), stored);
  }
  return config;
}

function load(key: SessionKey): StoredSession | null {
  const file = sessionFileFor(key);
  if (!existsSync(file)) return null;
  return readStoredSession(file);
}

function list(workspaceId: string): SessionMetadata[] {
  const root = getWorkspaceSessionRootPath(assertStorageId('workspace', workspaceId));
  if (!existsSync(root)) return [];

  const metadata: SessionMetadata[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, SESSION_FILE_NAME);
    if (!existsSync(file)) continue;
    const header = readHeader(file);
    if (header) metadata.push(headerToMetadata(header));
  }
  return metadata.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

function deleteSession(key: SessionKey): boolean {
  const dir = sessionDirFor(key);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  removeLegacyWorkspaceSessionDir(key.workspaceId, key.sessionId);
  return true;
}

/**
 * F1.776 — remove a deleted session's PRE-storage-v2 folder,
 * `<config>/workspaces/<workspaceId>/sessions/<sessionId>/`.
 *
 * Builds before F1.765 (`cb493486d`) let codex's session-MCP child derive the
 * session folder in that old layout, so `remember` (scope session),
 * `transform_data`, `render_template`, `script_sandbox` and `todo_write` wrote
 * there, and deleting the session left it behind. Nothing else in a v2 config
 * writes that tree (a legacy config is refused, never migrated —
 * `stored-config-load.ts`), and the Workspace root is always Nessy-managed
 * storage ({@link getWorkspaceRootPath}), never a user folder, so the removal
 * cannot reach user files.
 *
 * REMOVED with the session, never MOVED into the v2 folder: `transform_data`
 * answers an ABSOLUTE path that the transcript's blocks keep as their `src`,
 * so a move would break those blocks while the session lives, and nothing
 * else reads the old tree. The residue, stated in the release notes: while
 * such a session lives, the session memory an old codex build saved there is
 * still not loaded.
 *
 * Best effort and never throws. Both callers run it AFTER the v2 folder is
 * gone, and `SessionManager.deleteSession`'s rollback restores the v2 record
 * only — a throw here would roll back a deletion that already happened. A
 * failure is logged and the stray folder stays, as it did before this fix.
 */
export function removeLegacyWorkspaceSessionDir(workspaceId: string, sessionId: string): void {
  try {
    const legacySessionsRoot = join(getWorkspaceRootPath(workspaceId), 'sessions');
    rmSync(resolveContainedPath(legacySessionsRoot, assertStorageId('session', sessionId)), { recursive: true, force: true });
  } catch (error) {
    debug(`[sessions] F1.776: could not remove the pre-storage-v2 folder of deleted session ${sessionId}:`, error);
  }
}

export function createSessionStore(layout: VerifiedStorageLayoutV2): SessionStore {
  if (layout?.storageLayoutVersion !== 2) {
    throw new Error('Session store requires verified storage layout v2');
  }
  return {
    ensureWorkspaceDir,
    getSessionPath,
    getSessionFilePath,
    create,
    load,
    list,
    delete: deleteSession,
  };
}

// UA3.1 — declared by interface merging: this file is cited by line across docs/ almost to its last line.
export interface CreateSessionOptions {
  /** UA3.1 — see `SessionConfig.projectId` (v0.13.4). */
  projectId?: string;
  /** UA3.1 — see `SessionConfig.parentSessionId`; `SessionManager.createSession` has checked it is a session of this workspace. */
  parentSessionId?: string;
  /** UA3.1 — see `SessionConfig.taskSlug`; `SessionManager.createSession` has checked it is a task slug. */
  taskSlug?: string;
  /** UA3.1 — see `SessionConfig.taskRunId`. */
  taskRunId?: string;
  /** UA3.1 — see `SessionConfig.taskNodeId`. */
  taskNodeId?: string;
  /** UA3.1 — see `SessionConfig.taskDraft`; `false` is a value and is persisted. */
  taskDraft?: boolean;
}

/**
 * UA3.1 — the v0.13.4 project and task fields, copied BY NAME like every other field `create` and
 * `headerToMetadata` carry (never a spread of the source, so nothing else rides along). A field is copied
 * when it is not `undefined`; `taskDraft: false` and `taskNodeCount: 0` are values and are kept.
 * Hoisted, so the two one-line call sites above (kept line for line) can use it.
 */
function taskSessionFieldsOf(source: Pick<SessionConfig, 'projectId' | 'parentSessionId' | 'taskSlug' | 'taskRunId' | 'taskNodeId' | 'taskNodeCount' | 'taskDraft'>): Pick<SessionConfig, 'projectId' | 'parentSessionId' | 'taskSlug' | 'taskRunId' | 'taskNodeId' | 'taskNodeCount' | 'taskDraft'> {
  return {
    ...(source.projectId !== undefined ? { projectId: source.projectId } : {}),
    ...(source.parentSessionId !== undefined ? { parentSessionId: source.parentSessionId } : {}),
    ...(source.taskSlug !== undefined ? { taskSlug: source.taskSlug } : {}),
    ...(source.taskRunId !== undefined ? { taskRunId: source.taskRunId } : {}),
    ...(source.taskNodeId !== undefined ? { taskNodeId: source.taskNodeId } : {}),
    ...(source.taskNodeCount !== undefined ? { taskNodeCount: source.taskNodeCount } : {}),
    ...(source.taskDraft !== undefined ? { taskDraft: source.taskDraft } : {}),
  };
}

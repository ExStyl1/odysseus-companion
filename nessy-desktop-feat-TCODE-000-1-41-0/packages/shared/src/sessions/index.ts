/**
 * Sessions Module
 *
 * Public exports for Workspace-ID-scoped session management (global v2 storage).
 *
 * Sessions are stored in JSONL format:
 * - Line 1: SessionHeader (metadata for fast list loading)
 * - Lines 2+: StoredMessage (one message per line)
 */

export { resolveWorktreeAwareWorkingDirectory } from './worktree-resume.ts';

// Types
export type {
  SessionStatus,
  SessionTokenUsage,
  StoredMessage,
  SessionConfig,
  StoredSession,
  SessionMetadata,
  SessionHeader,
  SessionPersistentField,
  PiGoalAccountingV1,
  PiGoalBudgetsV1,
  PiGoalEvaluationV1,
  PiGoalRecordV1,
  PiGoalSourceV1,
  PiGoalStateV1,
  PiGoalStatusV1,
  ExecutionObservationEnvelopeV1,
} from './types.ts';

// Composite session identity
export type { SessionKey } from './types.ts';

// Provider-scoped runtime conversation anchors (replaces the single, namespace-
// ambiguous `sdkSessionId` read).
export type { RuntimeAnchorMap } from './runtime-anchors.ts';
export {
  migrateLegacyAnchor,
  readAgentResumeAnchor,
  readRuntimeAnchor,
  writeRuntimeAnchor,
} from './runtime-anchors.ts';

// Canonical composite-session-key encoder (W5) for session-keyed singletons.
export { encodeSessionKey } from './session-key.ts';

// Global session store — the final ID-first facade (W5).
export type { SessionStore, CreateSessionOptions } from './store-v2.ts';
export { createSessionStore } from './store-v2.ts';

// Field constants
export { SESSION_PERSISTENT_FIELDS } from './types.ts';

// Storage functions
export {
  // Directory utilities (ID-first, global v2 layout)
  ensureSessionsDir,
  ensureSessionDir,
  getSessionDirPath,
  getSessionFilePath,
  getSessionAttachmentsPath,
  getSessionPlansDir,
  getSessionDataPath,
  getSessionDownloadsPath,
  ensureAttachmentsDir,
  // ID generation
  generateSessionId,
  // Session CRUD
  createSession,
  getOrCreateSessionById,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  getOrCreateLatestSession,
  // Metadata updates
  updateSessionSdkId,
  updateSessionMetadata,
  canUpdateSdkCwd,
  flagSession,
  unflagSession,
  setSessionStatus,
  setSessionLabels,
  // Pending plan execution (Accept & Compact flow)
  setPendingPlanExecution,
  markCompactionComplete,
  markPendingPlanExecutionDispatched,
  clearPendingPlanExecution,
  getPendingPlanExecution,
  // Session filtering
  listFlaggedSessions,
  listCompletedSessions,
  listInboxSessions,
  // Archive management
  archiveSession,
  unarchiveSession,
  listArchivedSessions,
  listActiveSessions,
  // Plan storage
  formatPlanAsMarkdown,
  parsePlanFromMarkdown,
  savePlanToFile,
  loadPlanFromFile,
  loadPlanFromPath,
  listPlanFiles,
  deletePlanFile,
  getMostRecentPlanFile,
  // Async persistence queue
  sessionPersistenceQueue,
  // Header metadata signature (for self-triggered event suppression)
  getHeaderMetadataSignature,
  // P6.535 — the per-session scratch directory named by `CLAUDE_JOB_DIR`
  getSessionJobDir,
} from './storage.ts';

// JSONL helpers (for direct access if needed)
export {
  readSessionHeader,
  readSessionJsonl,
  writeSessionJsonl,
  createSessionHeader,
  normalizeHeaderPermissionModes,
} from './jsonl.ts';

// Field utilities
export { pickSessionFields } from './utils.ts';

// Slug generator utilities
export {
  generateDatePrefix,
  generateHumanSlug,
  generateUniqueSessionId,
  parseSessionId,
  isHumanReadableId,
} from './slug-generator.ts';

// Word lists (for customization if needed)
export { ADJECTIVES, NOUNS } from './word-lists.ts';

// Session ID validation (security)
export {
  validateSessionId,
  sanitizeSessionId,
} from './validation.ts';

// Session bundle (export/import/dispatch)
export type {
  SessionBundle,
  BundleSessionHeader,
  BundleFile,
  BundleBranchInfo,
  DispatchMode,
} from './bundle.ts';
export {
  serializeSession,
  validateBundle,
  MAX_BUNDLE_SIZE_BYTES,
} from './bundle.ts';

export type {
  FileCheckpointEntry,
  FileCheckpointRuntimeEntry,
  CreateFileCheckpointOptions,
  FinalizeFileCheckpointOptions,
  RevertFileCheckpointOptions,
  FileCheckpointRevertResult,
  FileCheckpointGcResult,
  FileCheckpointSkipReason,
  FileCheckpointSkippedPath,
  FileCheckpointStoreRemoval,
} from './file-checkpoints.ts';
export {
  createFileCheckpoint,
  finalizeFileCheckpoint,
  listFileCheckpointBaselines,
  listFileCheckpoints,
  removeFileCheckpointStore,
  revertFileCheckpoint,
  RUNTIME_FILE_CHECKPOINT_PRODUCERS,
  runtimeProducesFileCheckpoints,
  SKIP_REASON_TEXT,
  sweepFileCheckpoints,
} from './file-checkpoints.ts';
export type { CheckpointGcBaseline, CheckpointGcPlan } from './checkpoint-gc.ts';
export type {
  RetentionPathClass,
  RetentionSweepOptions,
  RetentionSweepRemoval,
  RetentionSweepReport,
} from './retention-sweep.ts';
export { NEVER_SWEPT_SESSION_ROOT_ENTRIES, runRetentionSweep } from './retention-sweep.ts';

// R20 — the file-backed task list. Shared across sessions via NESSY_TASK_LIST_ID
// and swept by the retention pass above under the same cleanup key.
export {
  DEFAULT_TASK_LIST_ROOT,
  assertTaskListId,
  openTaskStore,
  resolveTaskListId,
  taskListDirectory,
} from './task-store.ts';
export type { TaskStore } from './task-store.ts';

// R27b — the session-scoped scheduled-task list. Project-rooted and per session,
// unlike the R20 task list above, which is config-rooted and shareable.
export {
  DAMAGED_LEGACY_CRON_SUFFIX,
  MAX_SESSION_CRON_TASKS,
  SESSION_CRON_DIR,
  SESSION_CRON_EXPIRY_MS,
  SESSION_CRON_ID_LENGTH,
  SessionCronStoreError,
  adoptLegacySessionCronStore,
  assertCronPathWritable,
  assertCronSessionId,
  generateSessionCronId,
  openSessionCronStore,
  sessionCronDirectory,
  sessionCronFile,
} from './cron-store.ts';
export type {
  SessionCronListState,
  SessionCronProjectDir,
  SessionCronRecord,
  SessionCronStore,
} from './cron-store.ts';

// R27b — fire-time policy: deterministic jitter, the seven-day final fire, and
// the no-catch-up cursor. Pure; the ticking service lives in server-core.
export {
  CRON_ONE_SHOT_EARLY_JITTER_MS,
  CRON_RECURRING_MAX_JITTER_MS,
  cronExpiresAt,
  cronJitterFraction,
  cronJitterOffsetMs,
  nextCronFireTime,
  planCronRestore,
  planCronTick,
} from './cron-scheduler.ts';
export type { CronFire, CronRestorePlan, CronTickInput, CronTickPlan } from './cron-scheduler.ts';
export type {
  WorktreeOrphanCandidate,
  WorktreeOrphanPlan,
  WorktreeOrphanSkip,
  WorktreeOrphanSkipReason,
} from './worktree-orphans.ts';
export { planWorktreeOrphanSweep } from './worktree-orphans.ts';
export { CHECKPOINT_RETENTION, planCheckpointGc } from './checkpoint-gc.ts';
// UA5.3 — the project unbind (v0.13.4), exported at the file end so no cited line above moves.
export { unbindProjectFromSessions } from './storage.ts';

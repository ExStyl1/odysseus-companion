/**
 * Session Types
 *
 * Sessions are Nessy-owned and stored globally at
 * SESSIONS_DIR/<workspaceId>/<sessionId>/session.jsonl, partitioned by immutable
 * Workspace ID. No DTO here carries a managed storage path.
 *
 * JSONL Format:
 * - Line 1: SessionHeader (metadata + pre-computed fields for fast list loading)
 * - Lines 2+: StoredMessage (one message per line)
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { AskUserQuestionItem, ContextUsageSnapshot, CostReporting, PersistedModelUsage, StoredAttachment, MessageRole, ToolStatus, AuthRequestType, AuthStatus, CredentialInputMode, StoredMessage, PiHarnessExecutionReceiptSummaryV1 } from '@nessy-agent/core/types';
import type { PiChildRestrictionsV1, PiChildSessionStateV1 } from '../agent/pi-harness/child-session-port.ts';
import type { ContinuationEnvelopeV1 } from '../agent/pi-harness/continuation-envelope.ts';
import type { RuntimeAnchorMap } from './runtime-anchors.ts';
import type { AgentProvider } from '../agent/backend/types.ts';
import type { HistoryCarryPlan } from '../protocol/runtime-switch.ts';
import type { SessionMemoryScopeOverride } from '../agent/memory/session-memory-scope.ts';

/**
 * Session fields that persist to disk.
 * Add new fields here - they automatically propagate to JSONL read/write
 * via pickSessionFields() utility.
 *
 * IMPORTANT: When adding a new field:
 * 1. Add it to this array
 * 2. Add it to SessionConfig interface below
 * 3. Done - serialization is automatic
 */
export const SESSION_PERSISTENT_FIELDS = [
  // Identity — Workspace identity is the immutable `workspaceId`; managed storage
  // paths (`workspaceRootPath`, `branchFromSessionPath`) are never persisted (W5).
  'id', 'workspaceId', 'sdkSessionId', 'sdkSessionAnchors', 'sdkCwd',
  // Timestamps
  'createdAt', 'lastUsedAt', 'lastMessageAt',
  // Display
  'name', 'isFlagged', 'sessionStatus', 'labels', 'hidden',
  // UB6.15 — the visible reason when the decision model moved the session to Needs Review.
  'statusSetByDecision',
  // Read tracking
  'lastReadMessageId', 'hasUnread',
  // Config
  'enabledSourceSlugs', 'permissionMode', 'previousPermissionMode', 'workingDirectory', 'piAgentViewOutcome',
  // Model/Connection
  'model', 'llmConnection', 'connectionLocked', 'thinkingLevel',
  // Sharing
  'sharedUrl', 'sharedId',
  // Plan execution
  'pendingPlanExecution',
  // Extension-first interaction state
  'taskState', 'goalState', 'pendingAskUser', 'pendingApproval', 'deferredToolCall', 'planModeState', 'childSessionState', 'mailboxState', 'worktreeLeaseState', 'piChildRestrictions', 'piChildBudgets', 'piChildCapabilityGeneration', 'piChildCapabilityView', 'piParentSessionKey', 'piContinuationEnvelope', 'piExecutionObservations',
  // Archive
  'isArchived', 'archivedAt',
  // Branching — composite parent identity + provider-native anchors, never a managed path.
  'branchFrom',
  // Remote transfer handoff
  'transferredSessionSummary',
  'transferredSessionSummaryApplied',
  // Cross-runtime handoff (a switch onto a runtime with no anchor of its own)
  'runtimeHandoffFrom',
  'runtimeHandoffApplied',
  'runtimeHandoffPlan',
  // Automation origin
  'triggeredBy',
  // Per-chat memory scope (P6.703)
  'memoryScopeOverride',
  // The reopen compact-or-keep answer, asked once per conversation (P6.500)
  'reopenCompactChoice', 'messageQueuePaused', 'wasInterrupted', 'pendingModelSwitchContext', 'kanbanColumn', 'projectId', 'parentSessionId', 'taskSlug', 'taskRunId', 'taskNodeId', 'taskNodeCount', 'taskDraft', // F1.1248 — a queue paused by Stop stays paused across a restart; UA2.1 — the board column (v0.13.4); UA3.1 — the v0.13.4 project and task fields
] as const;

export type SessionPersistentField = typeof SESSION_PERSISTENT_FIELDS[number];

/**
 * Session status (user-controlled, never automatic)
 *
 * Dynamic status ID referencing workspace status config.
 * Validated at runtime via validateSessionStatus().
 * Falls back to 'todo' if status doesn't exist.
 */
export type SessionStatus = string;

/** Versioned Pi interaction DTOs persisted in the canonical session record. */
export type PiTaskStatusV1 = 'pending' | 'in_progress' | 'completed' | 'deleted';
export interface PiTaskRecordV1 {
  id: string;
  title: string;
  status: PiTaskStatusV1;
  blockedBy: string[];
}
export interface PiTaskStateV1 {
  schemaVersion: 1;
  revision: number;
  tasks: PiTaskRecordV1[];
  tombstones: string[];
}
export type PiGoalStatusV1 = 'active' | 'complete' | 'blocked' | 'cancelled' | 'budget_exhausted';
export type PiGoalSourceV1 = 'user' | 'agent' | 'automation';
export type PiGoalBudgetReasonV1 = 'turn_limit' | 'token_limit' | 'cost_limit' | 'elapsed_limit';
export interface PiGoalBudgetsV1 {
  turnLimit: number;
  tokenLimit: number;
  costLimitUsd: number;
  elapsedLimitMs: number;
}
export interface PiGoalAccountingV1 {
  turns: number;
  tokens: number;
  costUsd: number;
  elapsedMs: number;
  startedAt: number;
  lastResumedAt: number;
  resumeCount: number;
  lastTurnId?: string;
}
export interface PiGoalEvaluationV1 {
  source: 'manual' | 'evaluator' | 'budget';
  verdict: 'not_complete' | 'complete_suggested' | 'completed' | 'blocked' | 'cancelled' | 'budget_exhausted' | 'resumed';
  reason: string;
  evidence: string[];
  evaluatedAt: number;
}
export interface PiGoalBlockingAuditV1 {
  condition: string;
  blockedBy: 'user' | 'external';
  consecutive: number;
}
export interface PiGoalRecordV1 {
  schemaVersion: 1;
  id: string;
  revision: number;
  source: PiGoalSourceV1;
  creator: string;
  condition: string;
  status: PiGoalStatusV1;
  budgets: PiGoalBudgetsV1;
  accounting: PiGoalAccountingV1;
  createdAt: number;
  updatedAt: number;
  blockingAudit?: PiGoalBlockingAuditV1;
  lastEvaluation?: PiGoalEvaluationV1;
}
export interface PiGoalStateV1 {
  schemaVersion: 1;
  goal?: PiGoalRecordV1;
}
export interface PiPendingAskUserV1 {
  schemaVersion: 1;
  requestId: string;
  question: string;
  options: string[];
  allowFreeText: boolean;
  timeoutMs?: number;
  /**
   * Batched AskUserQuestion superset (R7). Absent on legacy records, which
   * stay valid and hydrate unchanged; when present, `question`/`options` above
   * hold a first-question projection for downgraded consumers.
   */
  questions?: AskUserQuestionItem[];
}

/**
 * A pending permission prompt persisted with the session (R7 Task 4, beside
 * `pendingAskUser` — `ask_user` prompts stay on that field). Written when the
 * prompt is published through the PermissionRequest band, cleared when it is
 * answered; deliberately NOT cleared on dispose/shutdown so an app restart
 * re-presents the prompt on open. A renderer-safe snapshot of the request —
 * never tool input or credentials.
 */
export interface PiPendingApprovalV1 {
  schemaVersion: 1;
  requestId: string;
  toolName: string;
  description: string;
  type?: string;
  command?: string;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  noAlwaysAllow?: boolean; defaultToNo?: boolean; raisedBySubagent?: boolean; // F1.1231 — core `PermissionRequest.defaultToNo` (F1.1219), so a card re-fired after a restart keeps it; F1.961 — a background worker raised this (the request's `agentLabel`): the worker died with the previous process, so both F1.954 gates expire the restored record; additive, absent reads main-thread
  commandHash?: string;
  approvalTtlSeconds?: number;
  requestedAt: number;
}
export type PiPlanModeStateV1 =
  | { schemaVersion: 1; kind: 'inactive'; revision: number }
  | { schemaVersion: 1; kind: 'planning'; revision: number; previousMode: PermissionMode }
  | {
      schemaVersion: 1;
      kind: 'awaiting_user';
      revision: number;
      previousMode: PermissionMode;
      planPath: string;
      submissionId: string;
      notificationDispatched: boolean;
    };

/**
 * `documented, not implemented — R23 agent teams is an undecided subsystem.`
 *
 * The per-agent JSON mailbox of R23: "multiple full sessions run as a team with
 * a lead, a shared claimable task list, and a per-agent JSON mailbox, driven by
 * a `SendMessage` tool and gated by the `TeammateIdle` hook", whose first step
 * the parity audit records as "a judgement call on whether we want the model,
 * not a build".
 *
 * So this chain is a PARTIAL BUILD of an undecided feature, not dead weight
 * that escaped a sweep. Nothing on it is reachable today and that is the
 * correct state: {@link MailboxService} is constructed per Pi session with a
 * real persist closure but no `profile`, so `send()` refuses with
 * `peer-messaging-disabled`; `messageCount` is therefore permanently `0` in the
 * harness snapshot, and no renderer reads it. Live inter-session messaging is
 * the unrelated `send_agent_message`.
 *
 * Do not delete it and do not wire it up without the R23 decision — either move
 * would pre-empt the judgement call. `fromAgentId` in particular only means
 * something once a team has agent identities to address.
 */
export interface PiMailboxMessageV1 {
  schemaVersion: 1;
  id: string;
  /** The sending teammate. Meaningful only under R23's team identities. */
  fromAgentId: string;
  toAgentId: string;
  body: string;
  kind: 'message';
}
/** See {@link PiMailboxMessageV1} — R23 machinery, deliberately unreachable. */
export interface PiMailboxStateV1 {
  schemaVersion: 1;
  revision: number;
  messages: PiMailboxMessageV1[];
}
export interface PiWorktreeLeaseV1 {
  schemaVersion: 1;
  worktreeLeaseId: string;
  workspaceId: string;
  ownerAgentId: string;
  path: string;
  branch: string;
  baseSha: string;
  status: 'creating' | 'active';
  /**
   * ISO timestamp of the last acquire, enter or exit for this lease.
   *
   * The enumeration seam R12's retention sweep needs — "the same age cutoff
   * applies to automatic removal of orphaned worktrees at startup" is
   * unanswerable without one, and nothing else on a lease records time. R2
   * stamps it and stops: the sweep, the dirty/unpushed skip and the lock
   * release are all R12's.
   *
   * Optional because leases persisted before this field existed have none; a
   * sweep must treat an absent value as "unknown", never as "epoch".
   */
  lastUsedAt?: string;
  /**
   * P6.547 — TRUE only when the host minted this branch for this worktree,
   * recorded at creation from the `show-ref` the creation already runs.
   *
   * Absent means "we do not know", which is the same thing as "do not touch the
   * branch": every lease written before this field existed reads that way, and a
   * branch that already existed is the user's.
   */
  branchCreated?: boolean;
  /**
   * P6.336 (b) — a PERMANENT worktree: one meant to outlive every chat that
   * used it.
   *
   * Before this the store had two lifetimes, "young enough" and "gone": a
   * worktree an operator wanted to keep survived only by being used often
   * enough, and stopped surviving the moment it went quiet. The sweep now names
   * it in its exemption set (`WorktreeSweepSkipReason` `'permanent'`) rather
   * than inferring it from age, a lock or a dirty tree — which is the whole
   * point, because all three of those are accidents of timing.
   *
   * Absent means "not permanent", so every lease written before this field
   * existed keeps exactly the lifetime it had.
   */
  permanent?: boolean;
}
export interface PiWorktreeLeaseStateV1 {
  schemaVersion: 1;
  revision: number;
  leases: PiWorktreeLeaseV1[];
}

/**
 * Built-in status IDs (for TypeScript consumers)
 * These are the default statuses but users can add/remove custom ones
 */
export type BuiltInStatusId = 'todo' | 'in-progress' | 'needs-review' | 'done' | 'cancelled';

/**
 * Session token usage tracking
 */
export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Model's context window size in tokens (from SDK modelUsage) */
  contextWindow?: number;
  /**
   * Per-model breakdown, keyed by the model string the backend reported. Present
   * only for backends that report one; see `PersistedModelUsage`.
   */
  modelUsage?: Record<string, PersistedModelUsage>;
  /**
   * Whether `costUsd` is a figure a backend established, rather than the zero a
   * cost-less backend leaves behind. See `CostReporting`.
   */
  costReporting?: CostReporting;
  /**
   * Last context snapshot (totals + the optional `/context` category
   * breakdown). Persisted with the header so a reloaded session still renders
   * its last breakdown; runtime code was already writing it through the wider
   * TokenUsage shape — declaring it here makes the persisted contract explicit.
   */
  contextUsage?: ContextUsageSnapshot;
}

/**
 * Stored message format (simplified for persistence)
 * Re-exported from @nessy-agent/core for convenience
 */
export type { StoredMessage } from '@nessy-agent/core/types';

/**
 * ============================================================
 * Session Types (canonical, ID-first — W4 seed, W5 cutover)
 * ============================================================
 *
 * Sessions are stored globally at SESSIONS_DIR/<workspaceId>/<sessionId>/session.jsonl,
 * partitioned by immutable Workspace ID rather than a Workspace-relative path.
 * These v2 DTOs never persist `workspaceRootPath` or `branchFromSessionPath` (both are
 * managed storage paths); Workspace identity is `workspaceId` and branch lineage is a
 * composite parent `SessionKey` plus provider-native anchors. There is no migration DTO
 * or transform API. W5 stage c made these the canonical unversioned names; the legacy
 * `workspaceRootPath`-first v1 DTOs are deleted.
 */

/** Identifies one session by its immutable Workspace ID and session ID. */
export interface SessionKey {
  workspaceId: string;
  sessionId: string;
}

/** Canonical durable Pi receipt envelope. `receipt` is already renderer-safe. */
export interface ExecutionObservationEnvelopeV1 {
  schemaVersion: 1;
  kind: 'tool_execution';
  session: Readonly<SessionKey>;
  observedAt: number;
  receipt: PiHarnessExecutionReceiptSummaryV1;
}

/**
 * Session configuration (v2, persisted metadata).
 */
export interface SessionConfig {
  id: string;
  /** Immutable Workspace ID this session belongs to. */
  workspaceId: string;
  /** SDK session ID (captured after first message) */
  sdkSessionId?: string;
  /**
   * Per-runtime conversation anchors. `sdkSessionId` is kept as the legacy
   * slot for sessions written before this field existed and for the ONE
   * runtime a given session is currently on; readers must go through
   * `readRuntimeAnchor`/`migrateLegacyAnchor` rather than either field.
   */
  sdkSessionAnchors?: RuntimeAnchorMap;
  /** Optional user-defined name */
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  /** Timestamp of last meaningful message (user or final assistant). Used for date grouping. */
  lastMessageAt?: number;
  /** Whether this session is flagged */
  isFlagged?: boolean;
  /** Permission mode for this session */
  permissionMode?: PermissionMode;
  /** Previous permission mode (used to preserve modeTransition context across restarts) */
  previousPermissionMode?: PermissionMode;
  /** User-controlled session status - determines inbox vs completed */
  sessionStatus?: SessionStatus;
  /** Labels applied to this session (bare IDs or "id::value" entries) */
  labels?: string[];
  /** ID of last message user has read */
  lastReadMessageId?: string;
  /** Explicit unread flag - single source of truth for NEW badge. */
  hasUnread?: boolean;
  /** Per-session source selection (source slugs) */
  enabledSourceSlugs?: string[];
  /** External project working directory for this session. Never a managed storage path. */
  workingDirectory?: string;
  /** Last terminal Pi turn outcome for server-derived Agent View state. */
  piAgentViewOutcome?: 'completed' | 'failed' | 'stopped';
  /**
   * SDK cwd for session storage - set once at creation, never changes. Defaults to this
   * session's own derived managed directory (no-project session); an explicit external
   * `workingDirectory` is preserved here instead.
   */
  sdkCwd?: string;
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string;
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string;
  /** Model to use for this session (overrides global config if set) */
  model?: string;
  /** LLM connection slug for this session (locked after first message) */
  llmConnection?: string;
  /** Whether the connection is locked (cannot be changed after first agent creation) */
  connectionLocked?: boolean;
  /** Thinking level for this session */
  thinkingLevel?: ThinkingLevel;
  /** Pending plan execution state - tracks "Accept & Compact" flow. */
  pendingPlanExecution?: {
    planPath: string;
    draftInputSnapshot?: string;
    awaitingCompaction: boolean;
    executionDispatched?: boolean;
  };
  taskState?: PiTaskStateV1;
  goalState?: PiGoalStateV1;
  pendingAskUser?: PiPendingAskUserV1;
  pendingApproval?: PiPendingApprovalV1;
  /** Durable deferred tool call (R7 Task 5); consumed on resume. */
  deferredToolCall?: import('../agent/pi-harness/deferred-tool-call.ts').PiDeferredToolCallV1;
  planModeState?: PiPlanModeStateV1;
  childSessionState?: PiChildSessionStateV1;
  /** R23 agent-teams machinery; see {@link PiMailboxMessageV1}. Never written. */
  mailboxState?: PiMailboxStateV1;
  worktreeLeaseState?: PiWorktreeLeaseStateV1;
  piChildRestrictions?: PiChildRestrictionsV1;
  piChildBudgets?: import('../agent/pi-harness/child-session-port.ts').PiChildBudgetsV1;
  piChildCapabilityGeneration?: string;
  piChildCapabilityView?: import('../capabilities/views.ts').AgentRuntimeView;
  /** Bounded durable references captured at the Pi compaction boundary. */
  piContinuationEnvelope?: ContinuationEnvelopeV1;
  /** Bounded, already-redacted Pi execution receipts. Raw tool data is never stored here. */
  piExecutionObservations?: readonly ExecutionObservationEnvelopeV1[];
  /**
   * Composite key of the parent session that spawned this Pi child, when any.
   * Present only on child sessions; the back-reference lets post-creation
   * permission-mode changes re-clamp against the parent's CURRENT mode so a
   * child can never be broadened past its parent after creation. Additive and
   * omit-when-default: absent on ordinary (non-child) sessions.
   */
  piParentSessionKey?: SessionKey;
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean;
  /** Whether this session is archived */
  isArchived?: boolean;
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number;
  /**
   * Branch lineage as a composite parent identity. Never a managed parent-session
   * filesystem path (no `branchFromSessionPath`).
   */
  branchFrom?: {
    parent: SessionKey;
    /** Message ID this session was branched from (hard context cutoff marker). */
    messageId?: string;
    /** Parent session's SDK session ID, for providers that support strict SDK-level forking. */
    sdkSessionId?: string;
    /** Provider transcript locator (e.g. Claude's per-cwd project hash), not a managed path. */
    sdkCwd?: string;
    /**
     * Provider-native branch anchor at the branch point.
     * - Claude: assistant message UUID (used as `resumeSessionAt`)
     * - Pi: session entry ID (used with the Pi SDK's branch(anchor))
     */
    sdkTurnId?: string;
  };
  /** One-shot hidden summary injected on the first turn after a remote transfer. */
  transferredSessionSummary?: string;
  /** Whether the transferred-session summary has already been injected. */
  transferredSessionSummaryApplied?: boolean;
  /**
   * Provider this session was moved OFF by a cross-runtime switch, until the
   * new runtime has been handed its context. Persisted because the switch and
   * the first turn on the new runtime are separated by an arbitrary gap — a
   * quit in between must not silently drop the handoff.
   */
  runtimeHandoffFrom?: AgentProvider;
  /** Whether the cross-runtime handoff context has already been injected. */
  runtimeHandoffApplied?: boolean;
  /**
   * What the switch DECIDED this handoff would cross as (`planHistoryCarry`,
   * P3 of `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`).
   *
   * Persisted for exactly the reason the two fields above are: the decision is
   * taken while the modal is on screen and consumed on the first turn of the
   * new runtime, and those two moments are separated by an arbitrary gap that
   * may include a quit. Without it here, the arm survives a restart and the
   * PLAN does not — the modal promises native history and the next launch
   * quietly delivers the 24×1200 text tail instead. Cleared with the arm.
   */
  runtimeHandoffPlan?: HistoryCarryPlan;
  /**
   * Metadata for sessions created by automations. `catchUpForOccurrenceAt` is
   * the epoch ms of the missed schedule a start/wake catch-up run is standing in
   * for (desktop-scheduled-tasks.md:74); absent on an on-time run.
   */
  // UB4.8 — `automationId` is what the loop guard matches against (a session never
  // re-triggers its own automation; sessions created before ids were recorded fall back
  // to the name) and `depth` bounds chains through OTHER automations at
  // MAX_AUTOMATION_CHAIN_DEPTH.
  triggeredBy?: { automationName?: string; automationId?: string; depth?: number; event?: string; timestamp?: number; catchUpForOccurrenceAt?: number };
  /**
   * P6.703 — this chat's own memory override, the thing that was missing while
   * the whole model shipped: `resolveSessionMemoryScope` was always called with
   * `undefined`, so every chat followed the global switch and a chat a user had
   * excluded was indistinguishable from one they had not.
   *
   * Each axis is INDEPENDENTLY unset, and an unset axis follows the global
   * switch — which is what "without touching the global setting" means, and why
   * an absent field is byte-identical to today's behaviour.
   *
   * Named `memoryScopeOverride` rather than W8-m's proposed `memoryScope`: what
   * is stored is the OVERRIDE, while `getSessionMemoryScope` answers with both
   * it and the RESOLVED scope, and those two are read side by side at every call
   * site the renderer has. One name for both is how they come to be confused.
   */
  memoryScopeOverride?: SessionMemoryScopeOverride;
  /**
   * P6.500 — the answer to the reopen compact-or-keep dialog, remembered so the
   * conversation is asked ONCE rather than on every reopen.
   *
   * Persisted rather than held in memory because "reopen" spans a restart, which
   * is the case the dialog exists for. `'summary'` ran `/compact`; `'as-is'` is
   * the user choosing to keep the whole history and pay for it. Absent means
   * never asked — the only state in which the dialog may appear.
   */
  reopenCompactChoice?: 'summary' | 'as-is';
  /**
   * F1.1248 — the message queue was PAUSED (a Stop, or a handoff that re-queued a steer) while it still held messages.
   * Written only then, and `true` only; the live flag is `queuePaused` on the managed session, which this mirrors at
   * every persist. Queue recovery reads it, so a message queued behind a stopped turn waits for the user's Send now or
   * Resume after a restart too, instead of being sent unattended at the next launch.
   */
  messageQueuePaused?: true;
  /**
   * F1.689 — the turn before was cut short (a Stop, or a quit with the turn still running), and the next prompt still
   * owes the model the note saying so. `true` only, mirroring `ManagedSession.wasInterrupted` at every persist.
   */
  wasInterrupted?: true;
  /**
   * UB12.104 — what the last `PostModelSwitch` run gave the model and the next prompt has not carried yet, mirroring
   * `ManagedSession.pendingModelSwitchContext` at every persist (absent once spent or cleared). Persisted for F1.689's
   * reason: the switch and the next prompt are separated by an arbitrary gap, and a quit in between dropped it.
   */
  pendingModelSwitchContext?: string;
}

/**
 * Stored session with conversation data (v2).
 */
export interface StoredSession extends SessionConfig {
  messages: StoredMessage[];
  tokenUsage: SessionTokenUsage;
}

/**
 * Session header (v2) - line 1 of session.jsonl.
 */
export interface SessionHeader extends SessionConfig {
  /** Number of messages in session */
  messageCount: number;
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  /** Preview of first user message (first 150 chars) */
  preview?: string;
  /**
   * P6.504 — one line of the session's OWN last output, precomputed here for
   * exactly the reason `preview` is: the session list must be able to say what
   * a session is doing without loading its messages, and (Q-den 22 = A)
   * without spending a model turn per row. `summarizeSessionOutput` is the
   * whole derivation; this field is only where it is stored.
   */
  lastOutputSummary?: string;
  /** Token usage statistics */
  tokenUsage: SessionTokenUsage;
  /** ID of the last final (non-intermediate) assistant message */
  lastFinalMessageId?: string;
}

/**
 * Session metadata (v2, lightweight, for lists)
 */
export interface SessionMetadata {
  id: string;
  workspaceId: string;
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  lastMessageAt?: number;
  messageCount: number;
  preview?: string;
  /** P6.504 — one line of the session's own last output. See `SessionHeader`. */
  lastOutputSummary?: string;
  sdkSessionId?: string;
  /**
   * Per-runtime conversation anchors. Carried on the listing metadata because
   * SessionManager hydrates its in-memory sessions from `SessionStore.list()`
   * at startup — dropping it here would lose the map on every restart and then
   * persist the loss.
   */
  sdkSessionAnchors?: RuntimeAnchorMap;
  isFlagged?: boolean;
  sessionStatus?: SessionStatus;
  labels?: string[];
  permissionMode?: PermissionMode;
  previousPermissionMode?: PermissionMode;
  sharedUrl?: string;
  sharedId?: string;
  workingDirectory?: string;
  piAgentViewOutcome?: SessionConfig['piAgentViewOutcome'];
  piExecutionObservations?: SessionConfig['piExecutionObservations'];
  sdkCwd?: string;
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  model?: string;
  llmConnection?: string;
  connectionLocked?: boolean;
  thinkingLevel?: ThinkingLevel;
  lastReadMessageId?: string;
  lastFinalMessageId?: string;
  hasUnread?: boolean;
  tokenUsage?: SessionTokenUsage;
  hidden?: boolean;
  isArchived?: boolean;
  archivedAt?: number;
  /** Number of plan files for this session (computed by the list path). */
  planCount?: number;
  /** Composite parent identity this session was branched from, if any. */
  branchFrom?: SessionConfig['branchFrom'];
  /**
   * Durable interaction state (R7 Task 4). Carried through the LISTING path so
   * a restart hydrates the pending question/prompt before the session is ever
   * opened — without these the header persisted them but `headerToMetadata`
   * dropped them, so a restart silently lost the pending interaction.
   */
  pendingAskUser?: PiPendingAskUserV1;
  pendingApproval?: PiPendingApprovalV1;
  /**
   * P3.312 — the worktree ledger, carried through the LISTING path for the same
   * reason as the two fields above and one more: a session that has not been
   * OPENED this run is exactly the session whose worktree leaks. Without this
   * the header persisted the leases and `headerToMetadata` dropped them, so
   * SessionManager hydrated an EMPTY ledger for every unopened session and no
   * sweep could ever see their worktrees — the leaked class P3.288 recorded.
   *
   * The legacy JSONL reader in `storage.ts` never had this gap: its
   * `headerToMetadata` spreads the header, so it has always carried the field
   * (untyped) while the live `store-v2` reader hand-copies and did not.
   */
  worktreeLeaseState?: PiWorktreeLeaseStateV1;
}

// UA2.1 — declared by interface merging so no docs-cited line above moves (this file is cited by line across docs/).
// Ported from craft-agents-oss v0.13.4 `packages/shared/src/sessions/types.ts` (Apache-2.0); the other
// v0.13.4 session fields (projectId, parentSessionId, task*) are UA3.1's.
export interface SessionConfig {
  /** UA2.1 — Kanban board column id ('todo' | 'in-progress' | 'done' or a project column). Drag-to-move target; independent of sessionStatus. */
  kanbanColumn?: string;
}
export interface SessionMetadata {
  /** UA2.1 — see {@link SessionConfig.kanbanColumn}; carried by the listing so a restart keeps the placement. */
  kanbanColumn?: string;
}

// UA3.1 — the other v0.13.4 session fields, declared by interface merging for the reason UA2.1 gives above.
// Ported from craft-agents-oss v0.13.4 `packages/shared/src/sessions/types.ts` (Apache-2.0). Persisted through
// `SESSION_PERSISTENT_FIELDS`; created through `store-v2.ts` `create` (copied by name) and listed through its
// `headerToMetadata` (copied by name), which is the path SessionManager hydrates from at startup.
export interface SessionConfig {
  /** UA3.1 — workspace-scoped project id this session belongs to (undefined = unbound). An entity id, never a folder: the folder is the project HANDLE (`projectHandleId`), see spec §12. */
  projectId?: string;
  /**
   * UA3.1 — parent session id: when set, this session is a subtask of the parent, or a Conductor child of
   * its orchestrator (undefined = top-level task). Always a session of the SAME workspace (`createSession`
   * refuses any other).
   *
   * NOT the field of the same name on `PermissionRequest` (`@nessy-agent/core` `message.ts`): that one is the
   * visible ANCESTOR a hidden child's permission prompt is routed to (decoded by iOS), set per request by the
   * orchestration layer. This one is a persisted board relationship on the session itself. The two never meet:
   * a hidden child's prompt routing does not read the session field, and the board does not read the
   * request field (spec §7, §22 item 8).
   */
  parentSessionId?: string;
  /** UA3.1 — Tasks Conductor: slug of the task spec this session belongs to (orchestrator and child nodes); `tasks/<slug>/` under the workspace root. */
  taskSlug?: string;
  /** UA3.1 — Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string;
  /** UA3.1 — Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string;
  /** UA3.1 — Tasks Conductor: total DAG node count (orchestrator only); a progress denominator that stays stable while children spawn lazily. */
  taskNodeCount?: number;
  /** UA3.1 — Tasks Conductor: a generate-time draft orchestrator, hidden from the board until adopted. Sent as `false`, never `undefined`, when cleared (spec §7). */
  taskDraft?: boolean;
}
export interface SessionMetadata {
  /** UA3.1 — see {@link SessionConfig.projectId}. */
  projectId?: string;
  /** UA3.1 — see {@link SessionConfig.parentSessionId} (not `PermissionRequest.parentSessionId`). */
  parentSessionId?: string;
  /** UA3.1 — see {@link SessionConfig.taskSlug}. */
  taskSlug?: string;
  /** UA3.1 — see {@link SessionConfig.taskRunId}. */
  taskRunId?: string;
  /** UA3.1 — see {@link SessionConfig.taskNodeId}. */
  taskNodeId?: string;
  /** UA3.1 — see {@link SessionConfig.taskNodeCount}. */
  taskNodeCount?: number;
  /** UA3.1 — see {@link SessionConfig.taskDraft}. */
  taskDraft?: boolean;
}

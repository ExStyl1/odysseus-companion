/**
 * SessionLifecycle
 *
 * Shared session lifecycle types and utilities for agent implementations.
 * Provides common abort reasons, session state, and cleanup patterns.
 *
 * The actual abort implementation is provider-specific:
 * - ClaudeAgent uses AbortController with the Claude SDK
 * - PiAgent signals the pi-agent-server subprocess via JSONL
 *
 * This module provides the shared types and utilities that both use.
 */

// ============================================================
// Types
// ============================================================

/**
 * Reason for aborting agent execution.
 * Used to distinguish user-initiated stops from internal aborts.
 */
export enum AbortReason {
  /** User clicked stop button */
  UserStop = 'user_stop',

  /** Agent submitted a plan and is awaiting review */
  PlanSubmitted = 'plan_submitted',

  /** Auth request triggered (OAuth, credential prompt) */
  AuthRequest = 'auth_request',

  /** New message sent while processing (silent redirect) */
  Redirect = 'redirect',

  /** Source activation requested - need to restart with new tools */
  SourceActivated = 'source_activated',

  /** Tool loop exceeded the configured per-turn event cap */
  MaxAgentTurns = 'max_agent_turns',

  /** Session cost exceeded the configured budget ceiling */
  MaxBudgetUsd = 'max_budget_usd',

  /**
   * P6.645 — session TOKENS exceeded the configured token ceiling.
   *
   * A separate reason from {@link MaxBudgetUsd} rather than a shared "budget"
   * one, because the two answer different questions and only one of them can be
   * answered on every runtime: money needs a runtime that reports cost or an
   * operator price table, tokens are reported by all three. A session stopped
   * by the token cap must not read as having spent money it may not have.
   */
  MaxBudgetTokens = 'max_budget_tokens',

  /**
   * No valid structured output remained within the retry limit (result subtype
   * `error_max_structured_output_retries`). The VALUE is the documented
   * `terminal_reason` (agent-sdk/typescript.md) — a distinct identifier from
   * the subtype and from the `NESSY_MAX_STRUCTURED_OUTPUT_RETRIES` knob.
   */
  StructuredOutputRetryExhausted = 'structured_output_retry_exhausted',

  /** Claude SDK result `stop_reason === 'refusal'` — carried on any subtype, including `success` */
  ProviderRefusal = 'provider_refusal',

  /** Claude SDK result subtype `error_during_execution`, or any unrecognized failure subtype */
  ProviderError = 'provider_error',

  /** A PreToolUse decision hook kept denying the same tool past the per-turn loop cap */
  HookLoopCap = 'hook_loop_cap',

  /** A PermissionRequest hook denied the prompt with `interrupt: true` (hooks.md: deny-only) */
  PermissionHookInterrupt = 'permission_hook_interrupt',

  /** Repeated overflow recovery immediately refilled the context after compaction */
  AutoCompactionThrashing = 'auto_compaction_thrashing',

  /** A headless PreToolUse hook deferred the turn's single tool call (hooks.md, R7 Task 5) */
  ToolDeferred = 'tool_deferred',

  /** The deferred tool no longer exists on resume; the run exits with is_error */
  ToolDeferredUnavailable = 'tool_deferred_unavailable',

  /** Session timeout */
  Timeout = 'timeout',

  /** Internal error requiring abort */
  InternalError = 'internal_error',
}

/**
 * Session state tracking for agent lifecycle.
 */
export interface SessionState {
  /** Unique session ID */
  sessionId: string;

  /** Whether the session is currently active */
  isActive: boolean;

  /** Number of messages/turns in this session */
  messageCount: number;

  /** Timestamp when session started */
  startedAt: number;

  /** Last activity timestamp */
  lastActivityAt: number;

  /** Whether there's been any assistant response content */
  hasReceivedContent: boolean;
}

/**
 * Configuration for session lifecycle management.
 */
export interface SessionLifecycleConfig {
  /** Session ID */
  sessionId: string;

  /** Optional callback when session state changes */
  onStateChange?: (state: SessionState) => void;

  /** Optional debug callback */
  onDebug?: (message: string) => void;
}

// ============================================================
// SessionLifecycleManager Class
// ============================================================

/**
 * Manages session lifecycle state.
 *
 * Tracks session activity and provides utilities for:
 * - Session state tracking (active, message count, timestamps)
 * - Abort reason management
 * - Session cleanup
 */
export class SessionLifecycleManager {
  private state: SessionState;
  private currentAbortReason: AbortReason | null = null;
  private config: SessionLifecycleConfig;

  constructor(config: SessionLifecycleConfig) {
    this.config = config;
    this.state = {
      sessionId: config.sessionId,
      isActive: true,
      messageCount: 0,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      hasReceivedContent: false,
    };
  }

  /**
   * Get current session state.
   */
  getState(): SessionState {
    return { ...this.state };
  }

  /**
   * Get the session ID.
   */
  getSessionId(): string {
    return this.state.sessionId;
  }

  /**
   * Check if this is the first message in the session.
   */
  isFirstMessage(): boolean {
    return this.state.messageCount === 0;
  }

  /**
   * Record that a message/turn has started.
   */
  recordMessageStart(): void {
    this.debug(`Message ${this.state.messageCount + 1} started`);
    this.state.lastActivityAt = Date.now();
  }

  /**
   * Record that a message/turn has completed.
   */
  recordMessageComplete(): void {
    this.state.messageCount++;
    this.state.lastActivityAt = Date.now();
    this.debug(`Message ${this.state.messageCount} completed`);
    this.notifyStateChange();
  }

  /**
   * Record that content has been received from the assistant.
   * Important for determining if abort should clear session state.
   */
  recordContentReceived(): void {
    if (!this.state.hasReceivedContent) {
      this.state.hasReceivedContent = true;
      this.debug('First content received');
      this.notifyStateChange();
    }
    this.state.lastActivityAt = Date.now();
  }

  /**
   * Set the abort reason for the current operation.
   * @returns Previous abort reason, if any.
   */
  setAbortReason(reason: AbortReason): AbortReason | null {
    const previous = this.currentAbortReason;
    this.currentAbortReason = reason;
    this.debug(`Abort reason set: ${reason}`);
    return previous;
  }

  /**
   * Get and clear the current abort reason.
   */
  consumeAbortReason(): AbortReason | null {
    const reason = this.currentAbortReason;
    this.currentAbortReason = null;
    return reason;
  }

  /**
   * Get the current abort reason without clearing it.
   */
  getAbortReason(): AbortReason | null {
    return this.currentAbortReason;
  }

  /**
   * Check if the abort was user-initiated.
   */
  wasUserAbort(): boolean {
    return this.currentAbortReason === AbortReason.UserStop;
  }

  /**
   * Check if abort should clear session state.
   *
   * Session state should be cleared if:
   * - Aborted before receiving any content
   * - AND it was the first message
   *
   * This prevents broken resume states.
   */
  shouldClearSessionOnAbort(): boolean {
    return !this.state.hasReceivedContent && this.state.messageCount === 0;
  }

  /**
   * Deactivate the session (e.g., on dispose).
   */
  deactivate(): void {
    this.state.isActive = false;
    this.currentAbortReason = null;
    this.debug('Session deactivated');
    this.notifyStateChange();
  }

  /**
   * Reset session state for a new conversation.
   */
  reset(): void {
    this.state = {
      sessionId: this.state.sessionId,
      isActive: true,
      messageCount: 0,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      hasReceivedContent: false,
    };
    this.currentAbortReason = null;
    this.debug('Session reset');
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    this.config.onStateChange?.(this.getState());
  }

  private debug(message: string): void {
    this.config.onDebug?.(`[SessionLifecycle] ${message}`);
  }
}

/**
 * Create a new SessionLifecycleManager.
 */
export function createSessionLifecycleManager(
  config: SessionLifecycleConfig
): SessionLifecycleManager {
  return new SessionLifecycleManager(config);
}

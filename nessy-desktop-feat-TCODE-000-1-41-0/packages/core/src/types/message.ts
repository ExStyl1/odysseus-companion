/**
 * Message types for conversations
 */

import type { OrchestrationProgress } from '../orchestration.ts';

/**
 * Message roles for display (runtime)
 */
export type MessageRole =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'error'
  | 'status'
  | 'info'
  | 'warning'
  | 'plan'
  | 'auth-request';

/**
 * Credential input modes for different auth types
 */
export type CredentialInputMode =
  | 'bearer'       // Single token field (Bearer Token, API Key)
  | 'basic'        // Username + Password fields
  | 'header'       // API Key with custom header name
  | 'query'        // API Key for query parameter
  | 'multi-header'; // Multiple header fields

/**
 * Auth request types
 */
export type AuthRequestType =
  | 'credential'
  | 'oauth'
  | 'oauth-google'
  | 'dp';

/**
 * Auth request status
 */
export type AuthStatus = 'pending' | 'completed' | 'cancelled' | 'failed';

/**
 * Tool execution status
 */
export type ToolStatus = 'pending' | 'executing' | 'completed' | 'error' | 'backgrounded';

/**
 * Tool display metadata - embedded at storage time for viewer compatibility
 * Icons are base64-encoded to work in both Electron and web viewer
 */
export interface ToolDisplayMeta {
  /** Display name for the tool (e.g., "Commit", "Linear") */
  displayName: string;
  /** Base64-encoded icon as data URL (e.g., "data:image/png;base64,...") - 32x32px */
  iconDataUrl?: string;
  /** Description of what this tool does */
  description?: string;
  /** Category for grouping/styling */
  category?: 'skill' | 'source' | 'native' | 'mcp';
}

/**
 * Attachment type categories
 */
export type AttachmentType = 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown';

/**
 * Attachment preview for display in user messages (runtime, before storage)
 */
export interface MessageAttachment {
  type: AttachmentType;
  name: string;
  mimeType: string;
  size: number;
  base64?: string;  // For images - enables thumbnail rendering
}

/**
 * Content badge for inline display in user messages
 * Badges are self-contained with all display data (label, icon)
 */
export interface ContentBadge {
  /** Badge type - used for fallback icon if iconBase64 not available */
  type: 'source' | 'skill' | 'context' | 'command' | 'file' | 'folder';
  /** Display label (e.g., "Linear", "Commit") */
  label: string;
  /** Original text pattern (e.g., "@linear", "@commit") */
  rawText: string;
  /** Icon as data URL (e.g., "data:image/png;base64,...") - preserves mime type */
  iconDataUrl?: string;
  /** Start position in content string */
  start: number;
  /** End position in content string */
  end: number;
  /**
   * Collapsed label for context badges (e.g., "Edit: Permissions")
   * When set, the badge replaces the entire marked range with this label
   * and hides the original content
   */
  collapsedLabel?: string;
  /**
   * File path for file badges - stores the full path for click handler
   * Used when the badge represents a clickable file reference
   */
  filePath?: string;
}

/**
 * Author metadata for annotations
 */
export interface AnnotationAuthor {
  id: string;
  name?: string;
  type?: 'user' | 'agent' | 'system';
}

/**
 * Annotation body payloads (extensible)
 */
export type AnnotationBody =
  | { type: 'highlight' }
  | { type: 'note'; text: string; format?: 'plain' | 'markdown' }
  | { type: 'tag'; value: string };

/**
 * Annotation intent (tight v1 semantics).
 */
export type AnnotationIntent = 'highlight' | 'comment' | 'question';

/**
 * Optional lifecycle status for annotation workflows.
 */
export type AnnotationStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed';

/**
 * Block types for block selectors.
 */
export type AnnotationBlockType =
  | 'paragraph'
  | 'code'
  | 'latex'
  | 'mermaid'
  | 'datatable'
  | 'spreadsheet'
  | 'image-preview'
  | 'pdf-preview'
  | 'html-preview';

/**
 * Selector union used to anchor an annotation target.
 * Multiple selectors can be stored for robust fallback resolution.
 */
export type AnnotationSelector =
  | {
      type: 'text-quote';
      exact: string;
      prefix?: string;
      suffix?: string;
    }
  | {
      type: 'text-position';
      start: number;
      end: number;
      textVersion?: string;
    }
  | {
      type: 'block';
      blockType: AnnotationBlockType;
      path: string;
      blockId?: string;
    }
  | {
      type: 'xywh';
      unit: 'pixel' | 'percent';
      x: number;
      y: number;
      w: number;
      h: number;
      page?: number;
      rotation?: number;
    }
  | {
      type: 'table-cell';
      rowKey: string | number;
      columnKey: string;
    };

/**
 * Annotation target definition.
 */
export interface AnnotationTarget {
  source: {
    sessionId: string;
    messageId: string;
  };
  selectors: AnnotationSelector[];
}

/**
 * Persisted annotation payload (schema-versioned for migration safety).
 */
export interface AnnotationV1 {
  id: string;
  schemaVersion: 1;
  createdAt: number;
  updatedAt?: number;
  createdBy?: AnnotationAuthor;
  deletedAt?: number;
  body: AnnotationBody[];
  target: AnnotationTarget;
  /** Optional workflow intent (tight v1 semantics). */
  intent?: AnnotationIntent;
  /** Optional lifecycle status. */
  status?: AnnotationStatus;
  /** Optional reference to the conversation/thread around this annotation. */
  threadRef?: {
    threadId?: string;
    sessionId?: string;
  };
  style?: {
    color?: 'yellow' | 'green' | 'blue' | 'pink' | string;
    opacity?: number;
  };
  meta?: Record<string, unknown>;
}

/**
 * Stored attachment metadata (persisted to disk, no base64)
 * Created when user sends a message with attachments
 */
export interface StoredAttachment {
  id: string;                    // Unique identifier
  type: AttachmentType;
  name: string;                  // Original filename
  mimeType: string;
  size: number;                  // Final size (after any resize)
  originalSize?: number;         // Original size before resize (if applicable)
  storedPath: string;            // Full path to copied file on disk
  thumbnailPath?: string;        // Path to OS-generated thumbnail (images/PDFs/Office)
  thumbnailBase64?: string;      // Base64-encoded thumbnail PNG (for renderer display)
  markdownPath?: string;         // For Office files: converted markdown for Claude
  wasResized?: boolean;          // True if image was auto-resized for Claude API limits
  resizedBase64?: string;        // Base64 of resized image (only when wasResized=true, for Claude API)
}

/** Renderer-safe attachment reference. Managed storage paths stay backend-only. */
export interface SessionAttachmentDto {
  handleId: string;
  type: AttachmentType;
  name: string;
  mimeType: string;
  size: number;
  previewUrl?: string;
}

/**
 * Runtime message type (includes transient fields like isStreaming)
 */
/**
 * Which runtime produced a message.
 *
 * Structurally identical to `ModelProvider` (`@nessy-agent/shared`
 * `config/models.ts`), restated here because `@nessy-agent/core` is the base
 * type layer and must not depend on `shared` — the same reason
 * `PiHarnessProviderV1` is restated in `pi-harness-runtime.ts`. The two unions
 * must be kept in step by hand; a member added there belongs here too.
 */
export type MessageRuntimeProvider = 'pi' | 'anthropic' | 'codex-runtime' | 'nestor-cloud-agent';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  /**
   * Provenance: the runtime this row was produced on, and the connection it ran
   * against. Optional and absent on every message written before session
   * runtime switching existed — a reader must treat "absent" as "the session's
   * current runtime", never as a distinct value.
   */
  runtime?: MessageRuntimeProvider;
  /** Slug of the `LlmConnection` this row ran against. See `runtime`. */
  llmConnection?: string;
  /**
   * R32 · what a `MessageDisplay` hook put on screen in place of `content`.
   *
   * RENDERER-ONLY and DISPLAY-ONLY. The main process never sets it — it builds
   * the persisted assistant `Message` from the original text — so it is never
   * written to `session.jsonl` and never survives a reload, which is precisely
   * what hooks.md:1273 requires: "the replacement text changes only what is
   * rendered on screen. The transcript and what Claude sees keep the original
   * text". Copy, export, branch-from-message and persistence all read `content`.
   */
  displayContent?: string;
  /**
   * C3.384 — the id the SERVER knows this row by, when it differs from `id`.
   *
   * RENDERER-ONLY, like {@link Message.displayContent} above: the main process
   * never sets it and it is never persisted. Set by the `user_message`
   * reconciler when the backend's canonical id differs from the optimistic one
   * the composer minted — which is the ordinary case, because the send path
   * mints its own id rather than adopting `optimisticMessageId`.
   *
   * ## Why the renderer keeps TWO ids instead of swapping to one
   *
   * The reconciler declines to overwrite `id`, for a measured reason recorded
   * there: `ChatDisplay`'s `getTurnKey` keys user bubbles by id, so a swap
   * remounts the bubble and wipes its local timer state and queued chip
   * mid-flight. That decision stands. What was wrong was the sentence beside it
   * claiming the canonical id is irrelevant to later events: every server call
   * that ADDRESSES a message by id needs this one, and
   * `SessionManager.rewindToMessage` looks the anchor up in `managed.messages`
   * and answers `Message not found` for an optimistic id.
   *
   * So: render by `id`, address the server by `serverId ?? id`. A row loaded
   * from the server carries no `serverId` and the fallback is then exact.
   */
  serverId?: string;
  timestamp: number;
  // Tool-specific fields
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  /**
   * P1 · what the runtime actually saw, before the display rewrite.
   *
   * `toolInput`/`toolResult` are display projections: their absolute paths are
   * rewritten relative to the session cwd for rendering. A cross-runtime
   * converter replaying history must feed the raw pair; rows persisted before
   * these fields existed lack them and fall back to the display fields
   * (degraded). The raw result keeps the display field's 200 000-char storage
   * cap — the raw copy's gain is the unrewritten paths, not unbounded length.
   */
  rawToolInput?: Record<string, unknown>;
  /** See `rawToolInput`. */
  rawToolResult?: string;
  toolStatus?: ToolStatus;
  toolDuration?: number;
  toolIntent?: string;
  toolDisplayName?: string;
  /** Tool display metadata with base64 icon - embedded at storage time for viewer */
  toolDisplayMeta?: ToolDisplayMeta;
  // Parent tool ID for nested tool calls (e.g., child tools inside Task subagent)
  parentToolUseId?: string;
  // Background task fields
  taskId?: string;          // For Task with run_in_background
  shellId?: string;         // For Bash with run_in_background
  elapsedSeconds?: number;  // Live progress updates
  orchestrationProgress?: OrchestrationProgress; // Live subagent/workflow progress
  isBackground?: boolean;   // Flag for UI differentiation
  // Renderer-safe attachment references. Persisted paths never cross this boundary.
  attachments?: SessionAttachmentDto[];
  // Content badges for inline display (sources, skills)
  badges?: ContentBadge[];
  /** Annotation payloads for this message */
  annotations?: AnnotationV1[];
  isError?: boolean;
  isStreaming?: boolean;
  // Pending: streaming text where we don't yet know if it's intermediate
  // Set to true when text_delta creates message, false when text_complete arrives
  // Also used for optimistic user messages before backend confirmation
  isPending?: boolean;
  // Queued: user message that is waiting to be processed (sent during ongoing response)
  isQueued?: boolean;
  // Intermediate text (commentary between tool calls, not final response)
  isIntermediate?: boolean;
  /**
   * P4.4 · this intermediate text is the model's REASONING, not its commentary.
   *
   * A narrowing of `isIntermediate`, never a replacement: every thinking
   * message is also intermediate, so nothing that only reads `isIntermediate`
   * changes behaviour. The renderer uses it to pick the `thinking` activity
   * type, which draws a different icon and — deliberately — stays out of the
   * collapsed turn preview, because reasoning is the most sensitive thing on
   * this wire and should cost the user an explicit expand.
   *
   * Never set for Anthropic `redacted_thinking` blocks: those carry an opaque
   * `data` field and no readable text, so the adapter drops them rather than
   * labelling a row it cannot fill.
   */
  isThinking?: boolean;
  /**
   * P6.481 · the thinking block's `signature`, when the producing runtime gave
   * one. See the `text_complete` event's own field for why it is kept.
   */
  thinkingSignature?: string;
  // Turn ID: Correlation ID from the API's message.id, groups all messages in an assistant turn
  turnId?: string;
  // Status type for special status messages (e.g., compacting, retrying)
  statusType?: 'compacting' | 'compaction_complete' | 'retrying';
  // Info level for info messages (determines icon/color)
  infoLevel?: 'info' | 'warning' | 'error' | 'success';
  // Error-specific fields (for typed errors with diagnostics)
  errorCode?: string;
  errorTitle?: string;
  errorDetails?: string[];
  errorOriginal?: string;
  errorCanRetry?: boolean;
  errorActions?: Array<{
    key: string;
    label: string;
    /**
     * D1.283 — the slash command the producer named, carried rather than
     * dropped. `RecoveryAction` in this same file has always declared it and
     * these two wire copies of the shape did not, so the renderer's mapper had
     * nothing to map and an action that named only a command reached the user
     * as a button with a label and no behaviour.
     */
    command?: string;
    action?: 'retry' | 'settings' | 'reauth' | 'open_url';
    url?: string;
  }>;
  // Plan-specific fields (for role='plan')
  planHandleId?: string;
  planName?: string;
  // Auth-request-specific fields (for role='auth-request')
  authRequestId?: string;         // Unique ID for the auth request
  authRequestType?: AuthRequestType;
  authSourceSlug?: string;
  authSourceName?: string;
  /**
   * The plugin-owned MCP server this request targets, when it has one.
   *
   * `authSourceSlug` is the DISPLAY identity — for a plugin server it is just
   * the server name, and there is no workspace source by that name to look up.
   * Without this field the in-chat card sent a bare `sourceSlug`, `oauth:start`
   * took the Source branch, and a real sign-in died on `Source not found:
   * <server>` — while the same sign-in from the MCP panel worked, because that
   * surface supplies the target. The producer already knows it
   * (`session-tools-core/handlers/source-oauth.ts`); it was dropped on the way
   * to the message.
   */
  authPluginServer?: { pluginKey: string; serverName: string };
  authStatus?: AuthStatus;
  authCredentialMode?: CredentialInputMode;  // For credential requests
  authHeaderName?: string;        // For header auth - the header name
  authHeaderNames?: string[];     // For multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])
  authLabels?: {                  // Custom field labels
    credential?: string;
    username?: string;
    password?: string;
  };
  authDescription?: string;       // Description/instructions
  authHint?: string;              // Hint about where to find credentials
  authSourceUrl?: string;         // Source URL for password manager domain matching (1Password)
  authPasswordRequired?: boolean; // For basic auth: whether password is required (default true)
  authError?: string;             // Error message if auth failed
  authEmail?: string;             // Authenticated email (for OAuth)
  authWorkspace?: string;         // Authenticated workspace (for Slack)
}

/**
 * Stored message format (persistence)
 * Excludes transient runtime-only fields (isStreaming, isPending)
 */
export interface StoredMessage {
  id: string;
  type: MessageRole;
  content: string;
  timestamp?: number;
  /** Provenance, persisted. See `Message.runtime`. */
  runtime?: MessageRuntimeProvider;
  /** Provenance, persisted. See `Message.llmConnection`. */
  llmConnection?: string;
  // Tool-specific fields
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  /** Raw (unformatted) tool input, persisted. See `Message.rawToolInput`. */
  rawToolInput?: Record<string, unknown>;
  /** Raw tool result, same 200 000-char cap as `toolResult`. See `Message.rawToolInput`. */
  rawToolResult?: string;
  toolStatus?: ToolStatus;
  toolDuration?: number;
  toolIntent?: string;
  toolDisplayName?: string;
  /** Tool display metadata with base64 icon - embedded at storage time for viewer */
  toolDisplayMeta?: ToolDisplayMeta;
  // Parent tool ID for nested tool calls (persisted for session restore)
  parentToolUseId?: string;
  // Background task fields (persisted)
  taskId?: string;
  shellId?: string;
  elapsedSeconds?: number;
  orchestrationProgress?: OrchestrationProgress;
  isBackground?: boolean;
  isError?: boolean;
  /** Stored attachments for user messages (persisted to disk) */
  attachments?: StoredAttachment[];
  /** Content badges for inline display (sources, skills) */
  badges?: ContentBadge[];
  /** Annotations persisted at message level */
  annotations?: AnnotationV1[];
  // Turn grouping - critical for TurnCard rendering after reload
  isIntermediate?: boolean;
  /** P4.4 · persisted so a reloaded transcript keeps reasoning rows distinct from commentary. */
  isThinking?: boolean;
  /**
   * P6.481 · persisted so a claude → claude switch can replay the row.
   *
   * Without it a rebuilt transcript can only STRIP the reasoning: the Messages
   * API's `ThinkingBlockParam` requires `signature`, so an unsigned block is
   * not a degraded read, it is an unsendable one.
   */
  thinkingSignature?: string;
  turnId?: string;
  // Status type for compaction/retry messages (persisted for reload)
  statusType?: 'compacting' | 'compaction_complete' | 'retrying';
  // Info level for info messages (persisted for reload)
  infoLevel?: 'info' | 'warning' | 'error' | 'success';
  // Error display fields
  errorCode?: string;
  errorTitle?: string;
  errorDetails?: string[];
  errorOriginal?: string;
  errorCanRetry?: boolean;
  errorActions?: Array<{
    key: string;
    label: string;
    /**
     * D1.283 — the slash command the producer named, carried rather than
     * dropped. `RecoveryAction` in this same file has always declared it and
     * these two wire copies of the shape did not, so the renderer's mapper had
     * nothing to map and an action that named only a command reached the user
     * as a button with a label and no behaviour.
     */
    command?: string;
    action?: 'retry' | 'settings' | 'reauth' | 'open_url';
    url?: string;
  }>;
  // Plan-specific fields (for role='plan')
  planPath?: string;
  // Auth-request-specific fields (for role='auth-request')
  authRequestId?: string;
  authRequestType?: AuthRequestType;
  authSourceSlug?: string;
  authSourceName?: string;
  authStatus?: AuthStatus;
  authCredentialMode?: CredentialInputMode;
  authHeaderName?: string;
  authHeaderNames?: string[];
  authLabels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  authDescription?: string;
  authHint?: string;
  authSourceUrl?: string;
  authPasswordRequired?: boolean;
  authError?: string;
  authEmail?: string;
  authWorkspace?: string;
  // Queued: user message that is waiting to be processed (persisted for recovery)
  isQueued?: boolean;
}

/**
 * Backend/runtime message shape before conversion to the renderer-safe DTO.
 *
 * `displayContent` is omitted deliberately (R32): it is a `MessageDisplay` hook's
 * on-screen replacement, and hooks.md:1273 says "The transcript and what Claude
 * sees keep the original text". Dropping it here makes that a TYPE error rather
 * than a convention — this is the shape `persistSession` writes to
 * `session.jsonl`, so a future writer cannot put the replacement on the
 * transcript by accident.
 */
export interface PersistedMessage extends Omit<Message, 'attachments' | 'planHandleId' | 'planName' | 'displayContent'> {
  attachments?: StoredAttachment[];
  planPath?: string;
}

/**
 * Whether a `costUsd` figure is one a backend actually established.
 *
 * The distinction exists because `costUsd` is a plain number that defaults to
 * zero, and a zero is indistinguishable from "this turn was free". Codex reports
 * no cost at all (its `thread/tokenUsage/updated` payload has token counts and
 * no money), and neither the Nessy Gateway nor Nestor Cloud returns one, so a
 * bare zero on those backends is a claim nothing made.
 *
 * - `reported` — every turn that produced usage carried a cost figure.
 * - `partial` — some did and some did not, so the total is a lower bound. A
 *   session that switches connection or model mid-way lands here.
 * - `unsupported` — no turn reported a cost. The total is not a number, it is
 *   an absence.
 *
 * Absent on records written before this field existed: unknown, not zero.
 */
export type CostReporting = 'reported' | 'partial' | 'unsupported';

/** One turn's verdict, before it is merged into a session's `CostReporting`. */
export type TurnCostReporting = 'reported' | 'unsupported';

/**
 * Per-model usage, accumulated across a session's turns.
 *
 * Field-for-field the additive subset of the SDK's `ModelUsage`
 * (`agent-sdk/typescript.md:4102`), renamed to this codebase's spelling:
 * `cacheReadInputTokens`/`cacheCreationInputTokens`/`costUSD` there are
 * `cacheReadTokens`/`cacheCreationTokens`/`costUsd` here. `contextWindow` and
 * `maxOutputTokens` are deliberately absent — they are model capacity, not
 * consumption, and summing them across turns is meaningless; capacity already
 * lives on `TokenUsage.contextWindow`.
 *
 * `canonicalModel` and `provider` are absent for a different reason, and that
 * reason CHANGED under this comment (P7.16, 2026-09-10). It said they "require
 * Claude Code v2.1.218 and the installed `@anthropic-ai/claude-agent-sdk`
 * typings do not carry them", which was true of the vendored `0.3.233`. The lift
 * to `0.3.247` declares both on `ModelUsage`, alongside a third arrival,
 * `costBasis?: 'list' | 'managed' | 'unknown'`. So they are readable now and are
 * still not read — deliberately, and for the reason the two absent capacity
 * fields above are absent: this interface is the ADDITIVE subset, accumulated
 * across a session's turns, and all three are per-request state the vendor's own
 * doc says is *"Overwritten per request"*. Summing or last-writer-wins over a
 * session would report one turn's provider as the session's.
 *
 * `costBasis` in particular is not merely unaccumulable here: the host's own
 * basis label already carries the same three words for the same three meanings
 * (`ChatDisplay.usage-format.ts`), and the child cannot see the host's managed
 * price table, so its verdict would contradict ours on exactly the sessions the
 * table exists for. That note is on the label, where a reader meets it.
 */
export interface PersistedModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  webSearchRequests: number;
  costUsd: number;
  /** This model's own cost verdict. See `CostReporting`. */
  costReporting: CostReporting;
}

/**
 * P6.616 — the cache breakdown a `/usage` readout can honestly render.
 *
 * Field-for-field the shape `UsageTracker.describeCachePerformance()` already
 * computed for P6.446 (`agent/core/usage-tracker.ts`), lifted onto the wire so
 * the renderer stops being the only place that could not see it. The tracker's
 * `CachePerformance` is now an alias of this type, so the two cannot drift.
 *
 * `warmth`'s third value is not a placeholder: `'unknown'` means no cache
 * counter has been non-zero on this session, which on a runtime whose adapter
 * does not report them yet is the truth, where `'cold'` would be a claim about
 * the provider. Deliberately no cost field — a cache-write is billed at a
 * different rate from a cache-read on every provider, this fork ships no price
 * table for the pair, and the two shipped comments recording "no honest value"
 * for the model-switch MONEY fields stay true. (They named three fields until
 * C4.22 and name two now: `cache_ttl` was sorted with them by its neighbours
 * rather than by what it is, and a lifetime this host resolves for itself is
 * not a price. The `ttl` member below is the same value, which is why it was
 * always safe to publish here.)
 */
export interface CacheUsageSnapshot {
  warmth: 'warm' | 'cold' | 'unknown';
  /** 0-1, cache-read tokens over total input. */
  hitRate: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * The resolved prompt-cache TTL, when the host resolved one
   * (`interceptor-common.ts:resolvePromptCacheTtl`). Absent means "the
   * runtime's own default", never a guess — and it is the ONE member of this
   * snapshot a renderer cannot derive for itself, because the resolution reads
   * the operator's environment and host config.
   */
  ttl?: '5m' | '1h';
}

/**
 * P6.616 — the ONE rule that turns cache counters into the breakdown above.
 *
 * It lives in this package, and not beside `UsageTracker` where it is used,
 * because THREE processes need the same arithmetic and one of them is the
 * renderer: `agent/core/usage-tracker.ts` reaches `node:fs` transitively
 * (`interceptor-common.ts` → `config/paths.ts`), so a renderer that imported
 * the rule from there would not build. Two copies of one formula is how a
 * breakdown comes to disagree with the headline it sits under.
 *
 * `totalInputTokens` must be the input figure that ALREADY INCLUDES both cache
 * halves, which is what every producer on this wire reports: the claude adapter
 * sums `input_tokens + cache_read + cache_creation` before emitting
 * (`agent/backend/claude/event-adapter.ts`), and codex's own `input_tokens`
 * contains the cached part by construction — `non_cached_input()` SUBTRACTS it
 * (`github.com/openai/codex`, `rust-v0.150.1`, `codex-rs/protocol/src/protocol.rs`).
 * Passing a fresh-only input here would overstate the hit rate, the same
 * double-count trap P6.446 recorded one level down.
 */
export function describeCacheUsage(
  counts: {
    totalInputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
  ttl?: '5m' | '1h',
): CacheUsageSnapshot {
  const cacheRead = Math.max(0, counts.cacheReadTokens ?? 0);
  const cacheCreation = Math.max(0, counts.cacheCreationTokens ?? 0);
  const totalInput = Math.max(0, counts.totalInputTokens);
  return {
    warmth: cacheRead > 0 ? 'warm' : cacheCreation > 0 ? 'cold' : 'unknown',
    hitRate: totalInput > 0 ? cacheRead / totalInput : 0,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    ...(ttl ? { ttl } : {}),
  };
}

/**
 * Token usage tracking
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * P6.616 — the derived cache breakdown (`warm`/`cold`, hit ratio, TTL).
   *
   * Stamped by the session layer, which is the only place that can fill `ttl`:
   * `resolvePromptCacheTtl` reads the operator's environment and host config,
   * and the renderer has neither. Everything else in the snapshot is derivable
   * from `inputTokens` + the two counters beside it, so a reader that finds
   * this member absent calls {@link describeCacheUsage} on those instead and
   * loses only the lifetime — which is why the field is optional rather than
   * required, and why a session persisted before it existed still renders.
   */
  cache?: CacheUsageSnapshot;
  /** Model's context window size in tokens. */
  contextWindow?: number;
  /** Rich provider-neutral context state. Unknown values stay null. */
  contextUsage?: ContextUsageSnapshot;
  /**
   * Per-model breakdown, keyed by the model string the backend reported.
   *
   * Present only for backends that report one — the Claude SDK's result message
   * carries `modelUsage` (`agent-sdk/cost-tracking.md:64`: it "Counts subagent
   * requests alongside the top-level loop, broken down by model"). Pi's usage
   * payload names no model, so a Pi session persists totals without a map.
   */
  modelUsage?: Record<string, PersistedModelUsage>;
  /** Whether `costUsd` is a figure a backend established. See `CostReporting`. */
  costReporting?: CostReporting;
}

/**
 * The seven documented `/context` categories (debug-your-config.md: "system
 * prompt, system tools, MCP tools, custom subagents with the source each
 * loaded from, memory files, skills, and conversation messages"), in display
 * order.
 */
export type ContextUsageCategoryId =
  | 'system_prompt'
  | 'system_tools'
  | 'mcp_tools'
  | 'custom_subagents'
  | 'memory_files'
  | 'skills'
  | 'conversation_messages';

export interface ContextUsageCategoryItem {
  /** Display name (subagent name, file identity). */
  name: string;
  /** Estimated tokens of this item's production-composed content. */
  tokens: number;
  /** Where the item loaded from (subagent provenance). */
  source?: string;
}

export interface ContextUsageCategory {
  id: ContextUsageCategoryId;
  /**
   * Estimated tokens, measured with `estimateTokens` over the SAME strings
   * production composed into context — never a re-composed copy.
   */
  tokens: number;
  /** Per-item rows (custom subagents carry the source each loaded from). */
  items?: ContextUsageCategoryItem[];
}

export interface ContextUsageLoadedFile {
  /** The instruction/memory layer identity actually loaded this session. */
  name: string;
  kind: 'instruction' | 'memory';
  tokens: number;
}

/**
 * The optimization suggestions `/context` may carry
 * (context-window.md:1616 — "run `/context` for a live breakdown by category
 * with optimization suggestions").
 *
 * Every id names a control that EXISTS in this product, because a suggestion
 * pointing at a control we do not have is worse than none:
 *
 * - `defer_mcp_tools` — deferred MCP tool loading (`NESSY_ENABLE_TOOL_SEARCH`,
 *   `workspaceDefaults.deferredMcpToolLoading`) and the per-server `alwaysLoad`
 *   pin that survives it.
 * - `trim_memory_files` — the `/memory` command, and the `instructionExcludes`
 *   / `claudeMdExcludes` setting that drops a file by path or glob.
 * - `gate_skill_listing` — `disable-model-invocation` in a skill's frontmatter,
 *   which keeps it out of the model's listing while leaving it user-invocable.
 */
export type ContextUsageSuggestionId =
  | 'defer_mcp_tools'
  | 'trim_memory_files'
  | 'gate_skill_listing';

export interface ContextUsageSuggestion {
  id: ContextUsageSuggestionId;
  /** The category row this suggestion is about; always one that is rendered. */
  category: ContextUsageCategoryId;
  /**
   * The token figure that triggered it — the SAME number the named category row
   * shows, so a suggestion can never disagree with the row above it.
   */
  tokens: number;
  /** How many items that figure covers (tool definitions, files, skills). */
  count?: number;
}

export interface ContextUsageSnapshot {
  modelId?: string;
  inputTokens: number | null;
  contextWindow?: number | null;
  contextWindowSource?:
    | 'runtime'
    /**
     * The runtime reported a window it did not measure — a synthetic default
     * stamped on a model whose real window nothing knows. Distinct from
     * `runtime` because the number is a guess, and distinct from `unavailable`
     * because the session is nonetheless running on it.
     */
    | 'fallback'
    | 'provider_catalog'
    | 'connection_override'
    | 'static_registry'
    | 'preset'
    | 'remote_reported'
    | 'unavailable';
  percent?: number | null;
  remainingWindow?: number | null;
  autoCompactionEnabled?: boolean | null;
  autoCompactionThreshold?: number | null;
  remainingBeforeAutoCompact?: number | null;
  reserveTokens?: number | null;
  isCompacting?: boolean;
  source: 'sdk_usage' | 'estimated_after_compact' | 'remote_reported' | 'unavailable';
  stale?: boolean;
  lastCompaction?: {
    tokensBefore?: number;
    estimatedTokensAfter?: number;
    firstKeptEntryId?: string;
  };
  /**
   * OPTIONAL wire fields: an old subprocess emitting no categories must render
   * exactly the totals-only overlay. No schema-version bump.
   */
  categories?: ContextUsageCategory[];
  /**
   * `inputTokens` minus the sum of the category estimates. Negative when the
   * estimator over-counts relative to the provider-reported total; null when
   * `inputTokens` is null. Present only alongside `categories`.
   */
  unattributedTokens?: number | null;
  loadedFiles?: ContextUsageLoadedFile[];
  /**
   * Optimization suggestions, produced beside the measurement from the same
   * numbers the category rows are built from. Empty or absent is the normal
   * case — a small composition has nothing worth advising about.
   */
  suggestions?: ContextUsageSuggestion[];
}

/**
 * Recovery action for typed errors
 */
export interface RecoveryAction {
  /** Keyboard shortcut (single letter) */
  key: string;
  /** Description of the action */
  label: string;
  /** Slash command to execute (e.g., '/settings') */
  command?: string;
  /**
   * Custom action type for special handling.
   *
   * D1.293 — the union carried a fifth member, `reconnect_source`, declared here
   * and in the two `errorActions` shapes above and produced by NOTHING: the
   * literal occurred only in the four type declarations, `ERROR_DEFINITIONS`
   * never emitted it, and the renderer's handler could only report it as
   * unrunnable. It is RETIRED rather than given a destination, because a
   * reconnect-from-an-error-card is product semantics nobody asked for; a
   * producer that ever appears brings its own. Its companion field `sourceSlug`
   * went with it — it existed for that action alone and the wire mapper always
   * carried `undefined` through it.
   *
   * `handleErrorMessageAction` runs all four and pins that with a compile-time
   * binding, so a member added here without a branch there is a type error.
   */
  action?: 'retry' | 'settings' | 'reauth' | 'open_url';
  /** URL to open (for open_url action) */
  url?: string;
}

/**
 * Error codes for typed errors - must match AgentError.code in shared/agent/errors.ts
 */
export type ErrorCode =
  | 'invalid_api_key'
  | 'invalid_credentials'
  | 'response_too_large'
  | 'expired_oauth_token'
  | 'token_expired'
  | 'rate_limited'
  | 'service_error'
  | 'service_unavailable'
  | 'network_error'
  | 'proxy_error'           // Proxy/firewall/captive portal intercepted the request
  | 'mcp_auth_required'
  | 'mcp_unreachable'
  | 'billing_error'
  | 'model_no_tool_support'  // Model doesn't support tool/function calling
  | 'invalid_model'          // Model ID not found
  | 'data_policy_error'      // OpenRouter data policy restriction
  | 'invalid_request'        // API rejected the request (e.g., bad image, invalid content)
  | 'image_too_large'        // Image exceeds API dimension/size limits
  | 'provider_error'         // AI provider experiencing issues (overloaded, unavailable)
  | 'queued_message_replay_failed'  // A message queued during an active turn could not be auto-replayed (#616)
  | 'sdk_binary_missing'     // SDK subprocess binary not present on disk (incomplete bundle)
  | 'sdk_cwd_missing'        // SDK subprocess cwd not present on disk (stale cross-machine import)
  | 'unknown_error';

/**
 * Typed error from agent
 */
export interface TypedError {
  /** Error code for programmatic handling */
  code: ErrorCode;
  /** User-friendly title */
  title: string;
  /** Detailed message explaining what went wrong */
  message: string;
  /** Suggested recovery actions */
  actions: RecoveryAction[];
  /** Whether auto-retry is possible */
  canRetry: boolean;
  /** Retry delay in ms (if canRetry is true) */
  retryDelayMs?: number;
  /** Diagnostic check results for debugging */
  details?: string[];
  /** Original error message for debugging */
  originalError?: string;
}

/**
 * Permission request type categories.
 *
 * ## P6.208 — the two carve-outs `permission-modes.md` puts on "approve and
 * switch to auto mode", measured here 2026-09-07 because THIS is the type a
 * renderer would branch on and neither carve-out is expressible from it
 *
 * The page requires the option to be ABSENT on a PowerShell prompt and on any
 * prompt forced by an ask rule or a hook, because auto mode still shows those.
 *
 *  1. **PowerShell — expressible? No. Reachable? Also no, and that is the part
 *     worth knowing.** No member of this union distinguishes a PowerShell call;
 *     `bash` is the category such a call would land in. But a PowerShell prompt
 *     cannot ARISE on this product: P6.530 (`44aee805e`) pins
 *     `CLAUDE_CODE_USE_POWERSHELL_TOOL` to the documented off value in every
 *     claude child, and the vendored binary's own gate reads that variable from
 *     the process environment (`if(platform!=="windows") return truthy(env)`),
 *     so the tool is never constructed; Pi and codex have no counterpart at all.
 *     Measured: `toolName: 'PowerShell'` is 0 occurrences across `packages` and
 *     `apps`. So this carve-out is satisfied BY CONSTRUCTION today, and adding a
 *     member for it would describe a prompt this product cannot produce.
 *  2. **Forced by an ask rule or a hook — expressible? No, and this one is a
 *     real gap.** The prompt's ORIGIN is nowhere on the card. It survives only
 *     as prose inside `reason` (`permissionDslAskReason` writes "Readable
 *     permission policy rule `X` (workspace scope) requires approval"), and a
 *     renderer that branched on that sentence would be parsing a message. A
 *     machine-readable origin is what a build of A40 needs FIRST — and it must
 *     be set by the producers, which is why the row has three holders and not
 *     one lane.
 *
 * A41's half (a comment on Yes/No that reaches the model) is blocked in the same
 * shape: `PermissionResponseOptions` (`shared/protocol/dto.ts`) carries
 * `rememberForMinutes`, `askUserAnswer` and `updatedInput` and no free text, and
 * the consumer that would route a comment into the tool result or the denial
 * reason is `SessionManager`. Controls for both readings: `switch to auto mode`
 * → 0 files, `permissionComment`/`commentField`/`denyComment` → 0 files each,
 * against `permissionMode` → 356 files — a reading of 2026-08-2x. Re-measured
 * 2026-09-12 (C3.319): `permissionComment` now matches 5 tracked files over
 * `packages apps` and `commentField` and `denyComment` 1 each — and the one file
 * behind those two is THIS comment. The zero is spent because the capability
 * shipped: the card offers the note, both locales carry
 * `chat.permissionComment.add` and `.placeholder`, and the surface is
 * `PermissionRequest.tsx`.
 */
export type PermissionRequestType = 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval' | 'workflow_launch' | 'worktree_approval' | 'worktree_setup' | 'worktree_cleanup' | 'ask_user' | 'outside_root' | 'permission_dsl';

/**
 * WHO raised this prompt — the machine-readable origin P6.208's affordance needs
 * and the `reason` sentence could only imply.
 *
 * Three members, one per producer, because that is exactly how many surfaces can
 * raise a card on this product:
 *
 *  - `host_gate` — the host asked. Our permission gate (a rule, a hook, the
 *    mode), or a host-owned prompt with no runtime behind it at all (Monitor,
 *    archive_session, a cross-session message, composer `!` shell).
 *  - `claude_native` — the claude child's own `can_use_tool` request arrived
 *    over the SDK and we are relaying it.
 *  - `codex_approval` — a codex requestApproval JSON-RPC request at
 *    `rust-v0.148.0`: `item/commandExecution/requestApproval`,
 *    `item/fileChange/requestApproval`, `item/permissions/requestApproval`.
 *    (Spelled out rather than globbed: a star-slash inside this block comment
 *    would close it — AGENTS.md §Traps, paid three times in this tree.)
 *
 * OPTIONAL, and absent means UNKNOWN — never "host". A prompt re-fired from a
 * durable record after a restart (`reprojectPendingApproval`) is the one live
 * case: the persisted `PiPendingApprovalV1` does not carry the origin, so the
 * re-fired card omits it rather than claiming the host raised what claude did.
 */
export const PERMISSION_REQUEST_ORIGIN_VALUES = [
  'host_gate',
  'claude_native',
  'codex_approval',
] as const;

/** @see PERMISSION_REQUEST_ORIGIN_VALUES */
export type PermissionRequestOrigin = typeof PERMISSION_REQUEST_ORIGIN_VALUES[number];

/**
 * P6.202 clause (3) — the payload of auto mode's FIRST read outside the working
 * directories, and the reason this card has THREE answers rather than two.
 *
 * `permission-modes.md#first-read-outside-the-working-directories` (an explicit
 * `<h3 id=…>` on the rendered page, so the anchor is published rather than
 * derived): *"While `permissions.blockReadsOutsideWorkingDirectories` is off,
 * file reads run without a prompt in auto mode, including reads outside the
 * working directories. The first time Claude uses the Read, Grep, or Glob tool
 * on a path outside them, Claude Code asks you whether to keep allowing those
 * reads."* And the carve-out, verbatim: *"The prompt doesn't appear in
 * non-interactive `-p` runs or background sessions; reads there run as before."*
 *
 * ## A payload field rather than a `PermissionRequestType` member
 *
 * Deliberate, and measured: the `PermissionRequestType` union is spelled out
 * VERBATIM in six places — here, `core/types/pi-harness-runtime.ts`,
 * `shared/agent/backend/types.ts`, `shared/protocol/pi-harness-runtime.ts`'s
 * validator and TWICE inside `SessionManager.ts` — so a new member is a
 * six-file edit for one card. Four fields on `PermissionRequest` already select
 * a different card shape this way (`askUser`, `noAlwaysAllow`,
 * `parentSessionId`, `agentLabel`); this is the fifth, and it keeps the card
 * `type` honest: the tool really is a `Read`/`Grep`/`Glob`.
 *
 * ## The three answers ride the two booleans the response already has
 *
 * `PermissionResponse` is `{ allowed, alwaysAllow }`, which is four
 * combinations for three answers, and the `outside_root` card already reads
 * that pair per card TYPE rather than universally. For THIS card:
 *
 *  - `allowed: true` → **Keep allowing** — *"the read runs, later reads outside
 *    the working directories run as before, and Claude Code records your answer
 *    so the prompt doesn't appear again"*.
 *  - `allowed: false, alwaysAllow: true` → **Block from now on** — *"the read is
 *    refused, and Claude Code sets `permissions.blockReadsOutsideWorkingDirectories`
 *    to `true` in your user settings"*. The "always" half applied to a REFUSAL,
 *    which is the one combination the pair had no meaning for.
 *  - `allowed: false, alwaysAllow: false` → **Ask again next time** — *"the read
 *    is refused, and the next read outside the working directories prompts
 *    again"*.
 *
 * The translation is `applyOutsideWorkingDirectoryReadAnswer`
 * (`shared/agent/mode-manager.ts`) so that no consumer has to re-derive it from
 * this comment.
 */
/**
 * P6.500 — the reopen dialog's payload: what makes this conversation expensive,
 * shown so the choice is informed rather than taken on trust.
 *
 * A NAMED payload whose PRESENCE selects the card, the same shape
 * {@link FirstOutsideReadPermissionRequest} uses and for the same reason: the
 * `PermissionRequestType` union is spelled out verbatim in several files
 * (including the Swift client's), so a new member costs a wire-drift sweep that
 * a payload does not.
 *
 * The card still carries `noAlwaysAllow`, and since P6.950 that flag means
 * exactly one thing: the GENERIC *Always Allow* is withheld, because its label
 * and its scope (this command, this repository, this session) are wrong for a
 * question about one conversation. A client that does not know this payload
 * therefore shows the two answers it already showed. The third answer is the
 * card's OWN button, in the renderer that does know the payload, and it rides
 * the same `alwaysAllow` boolean into `respondToPermission`'s host effect — the
 * shape `worktreeSetup` and `outsideWorkingDirectoryRead` both use.
 *
 * THE TRIGGER IS THE PAGE'S, both halves, because we have no plan tier to gate
 * it on and inventing two numbers would be exactly the unexplained constant the
 * row forbids. `sessions.md#resume-from-a-summary`, verbatim: *"On a Pro or Max
 * plan, when you resume a session that has been inactive for more than about an
 * hour and is over 100,000 tokens, Claude Code restores the conversation and
 * then opens a dialog before you send your first message."* The size half is a
 * host setting whose DEFAULT is that number; the hour is a constant beside the
 * host's own reader, cited there.
 *
 * ALL THREE ANSWERS since P6.950. *"Resume from summary"* and *"Resume full
 * session as-is"* are the compact-or-keep the row asked for; the third,
 * *"**Don't ask me again**: resumes the full session and stops showing the
 * dialog on all future resumes"*, is the as-is answer PLUS a global off switch,
 * and it is carried as `alwaysAllow` on a refusal — the one combination a
 * two-boolean answer had no meaning for, exactly as
 * {@link FirstOutsideReadPermissionRequest} uses it. The off switch it writes is
 * the host setting every other trigger lives in
 * (`disableReopenCompactPrompt`, `shared/config/storage.ts`), so the button and
 * `config.json` move the same one field.
 *
 * P6.500 shipped two and RECORDED the third rather than dropping it silently;
 * this paragraph said *"TWO ANSWERS, not the page's three"* until the owner's
 * 2026-09-10 ruling took it.
 */
export interface ReopenCompactPermissionRequest {
  /** The context this conversation is carrying, as the session recorded it. */
  contextTokens: number;
  /** The threshold that opened the dialog — the user can see WHY it appeared. */
  thresholdTokens: number;
  /** How long the conversation had been idle, in whole hours. */
  idleHours: number;
}

export interface FirstOutsideReadPermissionRequest {
  /** The path the tool is about to read, shown verbatim — it is the decision. */
  path: string;
  /**
   * The tool that asked, as the gate named it: `Read`/`Grep`/`Glob`, or Pi's
   * `Find`/`Ls`, which reach the same gate under their own permission names.
   */
  tool: string;
  /**
   * The working directory the path was measured against, when the producer can
   * say. Shown so the user can see WHY the path is outside rather than being
   * asked to take it on trust.
   */
  workingDirectory?: string;
}

/**
 * One option of a batched AskUserQuestion (user-input.md "Question format"):
 * `label` is what the user picks and what the answer envelope carries;
 * `description` explains it; `preview` is an optional visual and is absent
 * unless the session enables preview generation — consumers must check for
 * `undefined`.
 */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

/**
 * One batched question (user-input.md): 1-4 questions per call, 2-4 options
 * each, `header` is a short label capped at 12 characters, `multiSelect`
 * allows selecting several options.
 */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

/**
 * Answer returned from an interactive ask_user prompt.
 *
 * `option`/`free_text` are the legacy single-question forms. `batched` is the
 * documented AskUserQuestion envelope (user-input.md "Response format"):
 * `answers` keyed by question TEXT → selected label (array or ", "-join for
 * multi-select; free text for an "Other" answer), and `response` an optional
 * freeform reply that replaces the per-question list ("The user responded: …").
 * `autoContinued` marks an `askUserQuestionTimeout` expiry that submitted the
 * selections made so far with an away note — never a tool error.
 */
export type AskUserAnswer =
  | { type: 'option'; value: string; optionIndex: number }
  | { type: 'free_text'; value: string }
  | { type: 'batched'; answers: Record<string, string | string[]>; response?: string; autoContinued?: boolean };

/**
 * Interactive question payload carried through the existing permission channel.
 *
 * `question`/`options`/`allowFreeText` remain the legacy single-question shape
 * (and a first-question projection when `questions` is present, so downgraded
 * consumers still render something sane). `questions` is the batched superset.
 */
export interface AskUserPermissionRequest {
  question: string;
  options: string[];
  allowFreeText: boolean;
  timeoutMs?: number;
  /**
   * F1.818 — when the host ASKED the question, in epoch ms. The auto-continue
   * deadline is ask-anchored (`timeoutMs` from this instant — the clock the
   * host itself arms), so a card that mounts late shows the time actually left
   * instead of restarting the clock at mount. Absent from older hosts: the
   * card falls back to anchoring at mount, which is the pre-F1.818 behaviour.
   */
  askedAt?: number;
  questions?: AskUserQuestionItem[];
  /**
   * A server-supplied URL this prompt is asking consent to open, decomposed for
   * display. Set only by URL-mode MCP elicitation; absent everywhere else.
   *
   * `question` still carries the full URL in text, so a client that ignores this
   * field keeps satisfying the elicitation MUST to show the whole URL.
   */
  urlConsent?: AskUserUrlConsent;
}

/**
 * One way a host can be disguised, as computed by
 * `@nessy-agent/shared/mcp` `analyzeConsentUrl`. Rendering is the client's, but
 * the KINDS are fixed here so every client explains the same four things.
 *
 * - `punycode` — a host label is stored as `xn--…`; `decodedHost` shows what it
 *   renders as.
 * - `mixed-script` — one label mixes Latin with Cyrillic or Greek; `detail`
 *   names the scripts.
 * - `lookalike-suffix` — a whole domain name sits in an interior label, so the
 *   familiar part is decoration and `registrableDomain` is the real site.
 * - `embedded-credentials` — a `user@` before the host hides where it starts.
 */
export interface AskUserUrlConsentWarning {
  kind: 'punycode' | 'mixed-script' | 'lookalike-suffix' | 'embedded-credentials';
  detail?: string;
}

/** A URL to be opened after consent, with the parts a user has to compare. */
export interface AskUserUrlConsent {
  /** The full, untruncated URL — the one thing the client must always show. */
  url: string;
  /** The URL's host, exactly as the address spells it. */
  host: string;
  /** The party the browser will actually talk to; absent for an IP literal. */
  registrableDomain?: string;
  /** The host with its Punycode labels decoded; absent when they are identical. */
  decodedHost?: string;
  warnings: AskUserUrlConsentWarning[];
}

/** Optional Pi-only identity; absent for adjacent providers and legacy records. */
export interface PiToolIdentity {
  semanticId?: string;
  piName?: string;
  surfaceVersion?: number;
  originalName?: string;
  manifestGeneration?: string;
  manifestHash?: string;
  manifestProvenance?: string[];
}

/**
 * What a permission prompt's action does, as judged by the decision model
 * (opt-in, `riskBadges`). Informational badges only: they never change the
 * prompt or its outcome.
 *
 * UB6.10 — ported from craft-agents-oss `v0.15.1:packages/core/src/types/message.ts`
 * (first shipped v0.14.0; unchanged through v0.15.1; Apache-2.0).
 */
export type PermissionRisk = 'deletes' | 'sends' | 'publishes' | 'credentials' | 'system' | 'spends';

/**
 * Permission request from agent (e.g., bash command approval)
 */
export interface PermissionRequest extends PiToolIdentity {
  requestId: string;
  toolName: string;
  command?: string;  // Optional: bash commands have it, MCP tools may not
  description: string;
  type?: PermissionRequestType;  // Type of permission request
  /** Friendly app/package label for admin approval prompts */
  appName?: string;
  /** Plain-language reason shown in admin approval prompt */
  reason?: string;
  /** Plain-language impact shown in admin approval prompt */
  impact?: string;
  /** Whether native OS auth prompt is expected */
  requiresSystemPrompt?: boolean;
  /** Optional remember window for this exact command */
  rememberForMinutes?: number;
  /** Decision-model risk badges (opt-in); absent when the feature is off or unsure */
  risks?: PermissionRisk[];
  /**
   * This approval covers ONE action and cannot be remembered — the client must
   * not offer an always-allow choice.
   *
   * Set for Monitor's WebSocket source, which is documented as having "its own
   * approval prompt" that deliberately offers no skip-future-prompts option, and
   * by the cards whose producer remembers nothing (codex's floor and ask-rule
   * cards among them). Hiding the button is the client's half. The GENERAL server
   * half is F1.888's gate in `SessionManager.respondToPermission`
   * (`alwaysGrantOffered`): an Always sent to a card carrying this flag stores
   * neither the session remember window nor the repository Bash rule, while the
   * card-specific answers that ride the same boolean keep it. Monitor adds its
   * own: the request is resolved through a per-request resolver that has no
   * whitelist to write to, so an `alwaysAllow: true` answer cannot grant
   * anything beyond this call.
   */
  noAlwaysAllow?: boolean;
  /**
   * F1.1219 — one stray keystroke must not approve this request: the card opens
   * with focus on its decline answer and does not draw Allow as the default.
   *
   * Set from the Claude Agent SDK's own `canUseTool` hint, documented at
   * `agent-sdk/typescript.md#canusetool`: *"When `true`, a single stray keystroke
   * must not approve this request: open your prompt on its decline option, don't
   * pre-select approve, and offer no one-key approve shortcut."* Optional, and a
   * client that does not know it renders today's card (the iOS decoder ignores
   * unknown keys). The sibling hint, `suppressAlwaysAllowRule`, needs no field of
   * its own: it rides `noAlwaysAllow` above.
   */
  defaultToNo?: boolean; alwaysAllowScope?: 'workspace'; // F1.1236 — the producer saves Always Allow as a rule in the workspace permissions.json (codex's execpolicy grant), so the card says so; absent = the card's own per-type answer
  /** Hash binding for approval integrity checks */
  commandHash?: string;
  /** Approval validity window */
  approvalTtlSeconds?: number;
  /** Interactive user question shown by the ask_user tool */
  askUser?: AskUserPermissionRequest;
  /**
   * The VISIBLE session this prompt must surface in, when the session that
   * raised it is a hidden child.
   *
   * `sub-agents.md:1044` gives a fork "Prompts surface in your terminal" and a
   * background named subagent "Prompts surface in your main session"; `:770`
   * says background subagents "surface every permission prompt in your main
   * session". Both resolve to the same place for a desktop app: the ancestor
   * conversation the user is actually looking at.
   *
   * `sessionId` stays the CHILD's — it is what `respondToPermission` validates
   * the answer against — so this is a routing hint and never an authority.
   */
  parentSessionId?: string;
  /**
   * Which agent is asking.
   *
   * TWO producers, and they are not the same shape — this field said "for a
   * prompt surfaced in an ancestor session" while that was the only one
   * (C3.370, 2026-09-12):
   *
   * - Pi: `SessionManager.permissionSurfaceRouting` sets it beside
   *   `parentSessionId` when a HIDDEN CHILD SESSION's prompt has to be shown in
   *   its visible ancestor. The label is the child session's own name.
   * - claude: `claudeToolApprovalRequest` (`agent/claude-agent.ts`) sets it from
   *   the SDK's `canUseTool` `agentID` — *"If running within the context of a
   *   sub-agent, the sub-agent's ID"* — and there is **no ancestor session
   *   involved**, because a claude subagent runs inside the claude child and has
   *   no `ManagedSession` of its own. `parentSessionId` is correctly absent.
   *
   * So do not read this as implying `parentSessionId`, and do not gate the
   * rendering of one on the other: the card shows the chip whenever the label is
   * present, which is the behaviour both producers need.
   */
  agentLabel?: string;
  /**
   * Which surface raised this prompt. Absent means unknown — see
   * `PERMISSION_REQUEST_ORIGIN_VALUES`.
   */
  origin?: PermissionRequestOrigin;
  /**
   * Present ONLY on auto mode's first read outside the working directories, and
   * its presence is what selects the three-answer card — see
   * {@link FirstOutsideReadPermissionRequest} for the answers and the page.
   */
  outsideWorkingDirectoryRead?: FirstOutsideReadPermissionRequest;
  /**
   * P6.500 — present ONLY on the reopen compact-or-keep dialog, and its presence
   * is what selects that card. See {@link ReopenCompactPermissionRequest}.
   */
  reopenCompact?: ReopenCompactPermissionRequest;
  /**
   * P6.863 — the permission MODE alone raised this prompt: no ask rule, no
   * hook, no floor. A mode change can therefore remove it, which is the exact
   * question `permission-modes.md#switch-permission-modes` makes the
   * **Yes, and switch to auto mode** affordance turn on: *"Claude Code doesn't
   * add the option to prompts forced by one of your `ask` rules or by a hook,
   * because auto mode still shows you those prompts, so switching wouldn't
   * remove them."*
   *
   * Set at the gate's OWN two producer sites (`claude-agent.ts`,
   * `pi-agent.ts`) from `PreToolUseCheckResult.nonNegotiable` being absent —
   * that field's docblock says it is *"Absent on ordinary mode prompts"* — and,
   * on Pi, from the readable-DSL evaluation too, which the gate carries
   * separately as `dslEvaluation`.
   *
   * ABSENT MEANS UNKNOWN, never "the mode asked", and that is what makes it
   * safe to widen an affordance with: the seven host-owned surfaces that raise
   * prompts without going through `runPreToolUseChecks` at all — Monitor,
   * `archive_session`, the cross-session dialog, the plugin-hook and
   * skill-context Bash gates, composer `!` — never set it, and auto mode would
   * indeed still show every one of them.
   */
  modePrompt?: true;
}

/**
 * Usage data emitted by NessyAgent in 'complete' events
 * Note: This is a subset of TokenUsage - totalTokens/contextTokens are computed by consumers
 */
export interface AgentEventUsage {
  inputTokens: number;
  /**
   * How much context the session is LEFT HOLDING after this turn, when that is
   * not the same as what the turn consumed.
   *
   * The two coincide on an ordinary turn — each call sends the whole
   * conversation — which is why the session layer reads `inputTokens` as the
   * context size by default and this field is absent almost always. A
   * compaction turn is where they part: the model was sent the entire
   * pre-compaction conversation to summarize, so `inputTokens` is that whole
   * amount and is the honest consumption figure the usage metrics export, while
   * the context the session now holds is the summary. Reporting one number for
   * both meant either a badge that contradicted its own "Compacted" banner or a
   * consumption record understated by everything the compaction dropped.
   *
   * Backends may omit it. The session layer falls back to `inputTokens`, so a
   * backend that never sets it behaves exactly as before.
   */
  contextTokens?: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  /** Model's context window size in tokens (from SDK modelUsage) */
  contextWindow?: number;
  contextUsage?: ContextUsageSnapshot;
  /** This turn's per-model breakdown, when the backend reports one. */
  modelUsage?: Record<string, PersistedModelUsage>;
  /**
   * `reported` ONLY when `costUsd` is a figure this backend established for this
   * turn. Absence is read as `unsupported` by the session layer, which is why a
   * backend that cannot report cost needs no code here: silence already means
   * "we do not know" rather than "nothing was spent".
   */
  costReporting?: TurnCostReporting;
}

export interface AgentEventUsageUpdate {
  inputTokens?: number | null;
  contextWindow?: number | null;
  contextUsage?: ContextUsageSnapshot;
}

/**
 * Why a turn stopped, when it did not simply finish. Absent on a normal
 * completion. Values are the string values of `AbortReason`
 * (`shared/src/agent/core/session-lifecycle.ts`) — that enum is the single
 * vocabulary for stop causes, and this list deliberately mirrors it rather than
 * introducing a second one. `core` cannot import from `shared`, so the values are
 * spelled out here and pinned to the enum by a test
 * (`shared/src/agent/__tests__/adjacent-backend-frozen-contract.test.ts`).
 */
export const TERMINAL_REASON_VALUES = [
  'user_stop',
  'plan_submitted',
  'auth_request',
  'redirect',
  'source_activated',
  'max_agent_turns',
  'max_budget_usd',
  // P6.645 — the token twin of `max_budget_usd`, and deliberately its own
  // member: the USD cap can be unenforceable (a runtime that reports no cost
  // and no operator price table), while every runtime reports token counts, so
  // a session stopped by the token ceiling must not read as having spent money.
  'max_budget_tokens',
  // The DOCUMENTED terminal_reason for structured-output exhaustion
  // (agent-sdk/typescript.md; doc-verification § R18). Distinct from the
  // result subtype `error_max_structured_output_retries` and from the retry
  // knob env `NESSY_MAX_STRUCTURED_OUTPUT_RETRIES` — three identifiers.
  'structured_output_retry_exhausted',
  'provider_refusal',
  'provider_error',
  'hook_loop_cap',
  'permission_hook_interrupt',
  'auto_compaction_thrashing',
  // hooks.md "Defer a tool call for later" (R7 Task 5): a headless PreToolUse
  // hook deferred the single tool call; the run terminates SUCCESS with the
  // pending call preserved and `deferred_tool_use` on the complete event.
  'tool_deferred',
  // The deferred tool no longer exists on resume; exits with is_error.
  'tool_deferred_unavailable',
  'timeout',
  'internal_error',
] as const;

/** @see TERMINAL_REASON_VALUES */
export type AgentTerminalReason = typeof TERMINAL_REASON_VALUES[number];

/**
 * Prefix of the transcript `info` row that carries a turn's terminal VERDICT
 * (`terminal_reason:<reason>`), P2.37. Stored machine-readable — the same split
 * `runtime_switched:` uses — so the human sentence composed from
 * `chat.terminalReason.*` follows the UI language instead of freezing in
 * whichever one was active when the turn ended.
 *
 * It lives here, beside the reason vocabulary it embeds, for a cross-package
 * runtime reason: two consumers on opposite sides of a package boundary must
 * agree on the string — the renderer (`apps/electron/.../lib/terminal-reason-copy.ts`)
 * that WRITES the row and composes its copy, and `packages/ui`'s turn grouping
 * (`groupMessagesByTurn`) that must tell a verdict row apart from a genuine
 * mid-turn interruption. `packages/ui` cannot import from `apps/electron`, so a
 * renderer-local constant would have forced a duplicated literal and the exact
 * drift this row exists to prevent.
 */
export const TERMINAL_REASON_MARKER = 'terminal_reason:';

/** The `info`-row content that encodes `reason`. */
export function terminalReasonMarker(reason: AgentTerminalReason): string {
  return `${TERMINAL_REASON_MARKER}${reason}`;
}

/**
 * The reason a `terminal_reason:` row encodes, or `null` when `content` is an
 * ordinary notice. Structural only: which i18n key a reason maps to — and
 * whether it has copy at all — is a renderer concern
 * (`terminalReasonNoticeKey`), deliberately not decided here.
 */
export function parseTerminalReasonMarker(content: string): AgentTerminalReason | null {
  if (!content.startsWith(TERMINAL_REASON_MARKER)) return null;
  const reason = content.slice(TERMINAL_REASON_MARKER.length);
  return reason ? (reason as AgentTerminalReason) : null;
}

/**
 * The terminal reasons a verdict row is written FOR — the endings a user is
 * otherwise told nothing about.
 *
 * Read the tuple for how many; this comment said "five" while the tuple grew,
 * which is the drift `AGENTS.md` records about every prose count beside a
 * single-source-of-truth list.
 *
 * P2.98 moved this list here from the renderer, and the move is the point.
 * P2.37 composed the row renderer-side at `complete`, so a reload lost the one
 * thing the user most wants after a turn ends: why it ended. Persisting it
 * makes `SessionManager` a SECOND writer of the same row, and the two writers
 * must agree on which reasons get one — a server that persisted every reason
 * would write an invisible row on every `user_stop`, i.e. on every interrupt,
 * and `groupMessagesByTurn` reads a `terminal_reason:` row as NOT an
 * interruption, so those turns would stop grouping as interrupted.
 *
 * The remaining values in {@link TERMINAL_REASON_VALUES} are deliberately
 * absent: each already owns a louder surface (the interrupt row, the plan card,
 * the auth card, the follow-up turn it starts, or its own error notice). The
 * renderer's `NOTICE_KEY_BY_REASON` is TYPED against this tuple, so adding a
 * value here without writing it copy fails the build rather than leaking an
 * enum name into a transcript.
 *
 * P2.525 added the two deferral endings, and the reason is that the exemption
 * above was FALSE for them. Both were listed among the reasons that "reach the
 * transcript as their own error or info notices" and neither did: an ordinary
 * `tool_deferred` is a SUCCESS result with `is_error: false`, so nothing on any
 * surface said the turn ended with a tool held, and `tool_deferred_unavailable`
 * sets only `terminalIsError`, which this fork reads for cost accounting and
 * for nothing a user sees. A deferral is a promise to come back; a promise
 * nobody was told about is the stranded turn the row exists to prevent.
 *
 * Which i18n key each maps to stays a renderer concern; only membership is
 * shared, because only membership is what the two writers must not disagree on.
 */
export const TERMINAL_REASON_NOTICE_VALUES = [
  'max_agent_turns',
  'max_budget_usd',
  'max_budget_tokens',
  'structured_output_retry_exhausted',
  'provider_error',
  'provider_refusal',
  'tool_deferred',
  'tool_deferred_unavailable',
] as const;

/** @see TERMINAL_REASON_NOTICE_VALUES */
export type AgentTerminalReasonWithNotice = typeof TERMINAL_REASON_NOTICE_VALUES[number];

/** Whether this ending gets a verdict row at all. */
export function hasTerminalReasonNotice(
  reason: AgentTerminalReason | undefined,
): reason is AgentTerminalReasonWithNotice {
  return !!reason && (TERMINAL_REASON_NOTICE_VALUES as readonly string[]).includes(reason);
}

/**
 * The documented `deferred_tool_use` result payload carried on a
 * `tool_deferred` / `tool_deferred_unavailable` completion (hooks.md "Defer a
 * tool call for later", R7 Task 5). `terminalIsError` mirrors the documented
 * `is_error: true` on the unavailable exit.
 */
export interface AgentDeferredToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Events emitted by NessyAgent during chat
 * turnId: Correlation ID from the API's message.id, groups all events in an assistant turn
 * info.level reuses verbatim the four-value vocabulary already on
 * Message.infoLevel ('info' | 'warning' | 'error' | 'success' — see the two
 * infoLevel fields above) and on the wire DTO's info event
 * (packages/shared/src/protocol/dto.ts SessionEvent info variant, same four
 * values). Do not invent a fifth value here.
 */
/**
 * P6.109 — one entry of `background_tasks_replaced`.
 *
 * A NAMED type rather than an inline object, and not for style: the frozen
 * AgentEvent contract test reads each union branch's field names by regex, so an
 * inline shape would report `taskId` / `description` / `taskType` as fields of
 * the EVENT. Flat branches are that test's premise.
 */
export interface BackgroundTaskSummary {
  taskId: string
  /** The runtime's own human label. `taskType` is its documented fallback. */
  description?: string
  taskType?: string
  /**
   * UA12.18 — the `tool_use_id` of the call that started the task, as `task_started` reported it; absent when no
   * `task_started` with one was seen. It is the key `task_progress` is addressed by, so a row built from this feed
   * can take that progress; without it the renderer falls back to the task id and no progress reaches the row.
   */
  toolUseId?: string
}

/**
 * P6.916 / P6.942 — a retry's own facts, and the ONE place its vocabulary is
 * spelled.
 *
 * Three runtimes retry, and all three used to say so by assembling a sentence
 * the host then read back out: `SessionManager` recovered *is this a retry* with
 * three hand-written `startsWith` calls, and the renderer re-derived the attempt,
 * the cause and the wait with a regex. Four spellings of one vocabulary across
 * three packages, held together by nothing but per-producer tests.
 *
 * `AgentRetryFacts` is a NAMED type rather than an inline object, and for the
 * same reason {@link BackgroundTaskSummary} is one: the frozen AgentEvent
 * contract test reads each union branch's field names by regex, so an inline
 * shape would report `attempt` and `delaySeconds` as fields of the EVENT.
 *
 * The SENTENCE is still produced — it is the transcript entry, and a client that
 * does not read the field still shows a line — but it is now DERIVED from the
 * facts by {@link retryStatusMessage} instead of written out three times, so the
 * two ends cannot drift apart without the compiler saying so.
 */
export const RETRY_STATUS_PREFIXES = {
  rate_limit: 'Rate limited by the provider',
  provider_error: 'Provider error',
  succeeded: 'Retry succeeded',
} as const;

export type RetryStatusKind = keyof typeof RETRY_STATUS_PREFIXES;

/** The facts a retrying runtime published, as fields rather than as prose. */
export interface AgentRetryFacts {
  /** Which of the three lines this is; `succeeded` is the resolution. */
  kind: RetryStatusKind;
  /**
   * The runtime's OWN word for the cause, when it gave one — claude passes the
   * SDK's `error` code, Pi the first clause of the provider's own message.
   * Never a taxonomy of ours: a runtime that names no cause gets no cause.
   */
  cause?: string;
  /** Which attempt this is, when the runtime published one or the host counted it. */
  attempt?: number;
  /** How many attempts the runtime will make, when it published a budget. */
  maxAttempts?: number;
  /** The wait the runtime announced, in whole seconds. */
  delaySeconds?: number;
}

/**
 * `<prefix>[ (<cause>)][ — retry <n>[/<max>]][ in <s>s]`, and for the
 * resolution `Retry succeeded — resuming...`.
 *
 * Byte-identical to what the three producers assembled by hand before P6.916 —
 * the wording is a shipped surface (release note 1.20.1 quotes it verbatim), and
 * this change is about WHERE it is written, not about what it says.
 */
export function retryStatusMessage(facts: AgentRetryFacts): string {
  const head = facts.cause
    ? `${RETRY_STATUS_PREFIXES[facts.kind]} (${facts.cause})`
    : RETRY_STATUS_PREFIXES[facts.kind];
  if (facts.kind === 'succeeded') return `${head} — resuming...`;
  const parts: string[] = [];
  if (facts.attempt !== undefined) {
    parts.push(facts.maxAttempts !== undefined
      ? `retry ${facts.attempt}/${facts.maxAttempts}`
      : `retry ${facts.attempt}`);
  }
  if (facts.delaySeconds !== undefined && facts.delaySeconds > 0) {
    parts.push(`in ${facts.delaySeconds}s`);
  }
  return parts.length > 0 ? `${head} — ${parts.join(' ')}` : head;
}

/**
 * The whole `status` event for a retry: the facts, and the one sentence they
 * make. Every producer goes through here, which is what makes the vocabulary
 * single-sourced rather than merely documented.
 */
export function retryStatusEvent(
  facts: AgentRetryFacts,
): { type: 'status'; message: string; retry: AgentRetryFacts } {
  return { type: 'status', message: retryStatusMessage(facts), retry: facts };
}

export type AgentEvent =
  | {
      type: 'status';
      message: string;
      retry?: AgentRetryFacts;
      /**
       * F1.1150 (origin DN-229) — a runtime PHASE (codex's thread re-fork, codex's in-flight auto-review): a label for
       * the chip, never a transcript row, and an EMPTY message ends it. The host forwards it as `statusType: 'phase'`;
       * the renderer handles it as it handles a hook's `statusMessage`. Absent = an ordinary status (a row, and the
       * chip keeps it until the next status).
       */
      phase?: true;
    }
  | {
      type: 'info';
      message: string;
      level?: 'info' | 'warning' | 'error' | 'success';
      /**
       * D1.245 — this info is the ANSWER to a session command the user typed,
       * and the host keeps it in the transcript beside the question.
       *
       * The default (absent) is the ephemeral channel every other `info` uses,
       * and that default is deliberate: an unsolicited notice about a state
       * that can change — a lapsed `dp` session, a retry in flight — must NOT
       * become a transcript row claiming a condition that has since been fixed.
       * `SessionManager.recordSessionInfoEntry`'s docblock is where that rule
       * is written, and this flag is its third clause rather than an exception
       * to it: an answer the user ASKED FOR is a record of what happened, which
       * is the same thing every model turn in the same transcript is.
       *
       * Set at the `BaseAgent.chat` seam, which is the only place that knows an
       * info is an answer; the runtimes never set it. Never forwarded to the
       * renderer — it decides persistence on the host side and nothing else.
       */
      answersSessionCommand?: boolean;
      /**
       * F1.241 — on a "Compacted…" info: which compaction it reports. `manual` is the `/compact`
       * the user (or Accept & Compact) asked for; `auto` is the runtime's own. Each runtime
       * stamps it from its own signal (Pi `compaction_end.reason`, claude
       * `compact_metadata.trigger`, codex the turn that asked). An `auto` compaction never makes a
       * pending Accept & Compact plan ready; ABSENT is a producer that cannot say, and keeps the
       * behaviour from before the field (it does). Upstream (craft-agents-oss v0.13.4) carries
       * the same field and gates on `=== 'manual'`; this gate is `!== 'auto'` (an unstamped plan is
       * not stranded). F1.856: `manual` on an info that is NOT "Compacted…" is the manual compaction
       * REFUSED as nothing to compact (Pi, `PiAgent.runSessionCommand`): the plan is made ready.
       */
      compactionTrigger?: 'manual' | 'auto';
    }
  | { type: 'text_delta'; text: string; turnId?: string; parentToolUseId?: string }
  // F1.298 — a failed attempt's streamed text of turnId is void (Pi), from craft-agents-oss v0.13.4
  | { type: 'text_discard'; turnId: string }
  | {
      type: 'text_complete';
      text: string;
      isIntermediate?: boolean;
      isThinking?: boolean;
      /**
       * P6.481 · Anthropic's `signature` for a thinking block, carried only on
       * an `isThinking` event and only by the claude adapter.
       *
       * An ATTESTATION, and the reason it is worth persisting at all:
       * `ThinkingBlockParam` in `@anthropic-ai/sdk` declares
       * `signature: string` as REQUIRED, so a thinking block replayed to the
       * Messages API without one is not merely refused, it is not expressible.
       * Carrying it is what lets a claude → claude switch replay reasoning
       * instead of dropping it.
       */
      thinkingSignature?: string;
      turnId?: string;
      parentToolUseId?: string;
      sdkMessageId?: string;
      /**
       * P6.102 — the RUNTIME's own turn id for this message, when the runtime
       * has one and it is not already what `turnId` carries.
       *
       * `turnId` is a correlation id whose meaning is per-adapter: claude sets
       * it to the SDK message uuid (`msg_…`), Pi builds `<turn>__m0`, and codex
       * mints a per-MESSAGE identity `<codex turn id>__<kind>:<item id>` so two
       * messages in one turn do not overwrite each other in the renderer. That
       * makes `turnId` unusable as a branch anchor on codex, and parsing the
       * base back out would couple the host to an adapter's private format.
       *
       * So the adapter that knows the runtime's turn id states it here. The
       * only producer today is codex, whose `thread/fork` takes exactly this
       * value as `lastTurnId` ("turns after `last_turn_id` are omitted from the
       * fork"); claude and Pi carry their anchors in `turnId` and
       * `pi_turn_anchor` respectively and set nothing here.
       */
      runtimeTurnId?: string;
    }
  | { type: 'pi_turn_anchor'; sdkMessageId: string; sdkTurnAnchor: string }
  | ({ type: 'tool_start'; toolName: string; toolUseId: string; input: Record<string, unknown>; intent?: string; displayName?: string; turnId?: string; parentToolUseId?: string; toolDisplayMeta?: ToolDisplayMeta } & PiToolIdentity)
  | ({ type: 'tool_result'; toolUseId: string; toolName?: string; result: string; structuredContent?: Record<string, unknown>; isError: boolean; input?: Record<string, unknown>; turnId?: string; parentToolUseId?: string } & PiToolIdentity)
  | {
      type: 'permission_request';
      requestId: string;
      toolName: string;
      command?: string;
      description: string;
      permissionType?: PermissionRequestType;
      appName?: string;
      reason?: string;
      impact?: string;
      requiresSystemPrompt?: boolean;
      rememberForMinutes?: number;
      commandHash?: string;
      approvalTtlSeconds?: number;
      /** @see PERMISSION_REQUEST_ORIGIN_VALUES — absent means unknown, never host. */
      origin?: PermissionRequestOrigin;
    } & PiToolIdentity
  | { type: 'permission_request_cancelled'; requestId: string }
  | { type: 'error'; message: string }
  | { type: 'typed_error'; error: TypedError }
  | {
      type: 'complete';
      usage?: AgentEventUsage;
      terminalReason?: AgentTerminalReason;
      deferredToolUse?: AgentDeferredToolUse;
      terminalIsError?: boolean;
      /** R18: the validated turn structured output (success arm only; absent when no schema rode the turn). */
      structuredOutput?: unknown;
      /** R18: the documented result subtype for a schema-bearing turn. */
      structuredOutputSubtype?: 'success' | 'error_max_structured_output_retries';
      /** R18: the result's errors list — validation failures on exhaustion, or the non-validation ending's cause. */
      structuredOutputErrors?: string[];
    }
  | { type: 'working_directory_changed'; workingDirectory: string }
  | { type: 'task_backgrounded'; toolUseId: string; taskId: string; kind?: 'workflow' | 'subagent' | 'mcp'; intent?: string; turnId?: string }
  /**
   * P6.109 — the whole set of a runtime's background AGENT tasks, with REPLACE
   * semantics: swap your rows for this payload.
   *
   * A different fact from `task_backgrounded`, which announces ONE task's
   * registration and which `SessionManager` reacts to by retaining a child
   * authority. This one has no server-side effect: it is forwarded, and the row
   * source reconciles against it. Emitted by the claude backend, whose SDK feed
   * (`SDKBackgroundTasksChangedMessage`) is itself a replacement list and has no
   * per-task start or end event to map onto.
   *
   * `tasks: []` is meaningful and must be delivered — it is how the rows for
   * work that died with a restarted child are retired.
   */
  | { type: 'background_tasks_replaced'; tasks: readonly BackgroundTaskSummary[] }
  | { type: 'shell_backgrounded'; toolUseId: string; shellId: string; intent?: string; command?: string; turnId?: string }
  | { type: 'task_progress'; toolUseId: string; elapsedSeconds?: number; orchestrationProgress?: OrchestrationProgress; turnId?: string }
  // UB9.8 — craft-agents-oss v0.15.1 (Apache-2.0): what a running background task of the session's own agent is
  // doing (the Claude SDK's `task_progress`, read by `classifyClaudeTaskProgress`). `summary` is the SDK's one-line
  // status when it has one (an MCP task's own; agent summaries stay off, F1.901). Forwarded only for registered tasks.
  | { type: 'task_activity'; taskId: string; toolUseId?: string; summary?: string; lastToolName?: string; toolUses?: number; turnId?: string }
  | { type: 'task_completed'; taskId: string; status: 'completed' | 'failed' | 'stopped'; outputFile?: string; summary?: string; turnId?: string }
  | { type: 'task_notification'; taskId: string; text: string; turnId?: string }
  | { type: 'shell_killed'; shellId: string; turnId?: string }
  | { type: 'source_activated'; sourceSlug: string; originalMessage: string }
  | { type: 'usage_update'; usage: AgentEventUsageUpdate }
  | { type: 'steer_undelivered'; message: string; messageId?: string; origin?: 'monitor' };

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * F1.351 — this user entry is a background-task notification the HOST delivered
 * between turns (`SessionManager.flushPendingTaskNotifications`), not text the
 * user typed. The model received it as a user turn, which is why it is a `user`
 * entry at all; the renderer draws it as a LABELLED SYSTEM LINE (what it is and
 * where it came from) rather than the user's bubble — DECIDED by the controller
 * 2026-09-23, "not hidden", because hiding it would leave the model's reaction
 * inexplicable. `true` or absent; set only by the host.
 *
 * Declared by interface MERGING at the end of the file so that no docs-cited line
 * above moves; the fields are part of `Message`, `StoredMessage` and — through
 * `Omit<Message, …>` — `PersistedMessage`, and `messageToStored` /
 * `storedToMessage` carry them by their spreads.
 */
export interface Message {
  taskNotification?: true;
}

/** F1.351 — see {@link Message.taskNotification}. */
export interface StoredMessage {
  taskNotification?: true;
}

/**
 * UA1.18 — the `publish_artifact` card's payload: what is about to leave this machine, shown BEFORE the person
 * answers. Selected by its presence, as `reopenCompact` and `outsideWorkingDirectoryRead` are (a new
 * `PermissionRequestType` member would cost a wire-drift sweep across every client that spells the union). The host
 * (`SessionManager.publishArtifactForAgent`) fills it from the ONE buffer the publish guard read; nothing in it is a
 * token, and the preview is the normalised content that will be sent, capped for the wire.
 *
 * Declared by interface MERGING at the end of the file so that no docs-cited line above moves.
 */
export interface ArtifactPublishPermissionRequest {
  /** `create` = a new link; `update` = the same link (`url`), new content. */
  mode: 'create' | 'update';
  /** The file as the session named it (relative to its working folder where possible). */
  sourcePath: string;
  contentType: 'html' | 'markdown';
  /** The page title as it will appear (decoded for display; the host escapes it on the wire). */
  title: string;
  emoji: string;
  /** Bytes that will be sent (after normalisation). */
  byteLength: number;
  lineCount: number;
  /** sha256 hex of the file bytes the guard read; the card shows a prefix. */
  sha256: string;
  /** The service host, and who owns the page ("your dp account" — whichever dp session signs the request). */
  serviceOrigin: string;
  /**
   * UA12.27 — the LAST KNOWN dp login (the cached Nessy Gateway credential's), named "last known as" on the owner
   * line (P-UA-n-4); the publish is signed by a live dp print-token. Absent when unknown; the credential never rides the
   * payload (`shared/src/auth/dp` `readDpIdentity` is the only source, and its shape carries no token).
   */
  ownerLogin?: string;
  /** ISO timestamp the link stops working, or `null` for never (an update that keeps an unlimited page). */
  expiresAt: string | null;
  /**
   * UA12.66 — the host could not resolve the link's current expiry (a chat-share update whose registry row is gone
   * or unreadable): the card says so instead of reading `expiresAt: null` as "never". The update sends no retention,
   * so the service-side expiry is unchanged — unknown to this card, not endless.
   */
  expiresUnknown?: true;
  /** Days of retention SENT; absent on an update that keeps the current expiry. */
  retentionDays?: number;
  /** The update target's link. */
  url?: string;
  /** The normalised content, capped at `previewLimitBytes`; rendered with scripts disabled. */
  previewContent: string;
  previewTruncated: boolean;
  /** The first 40 lines of the file as read, capped at 64 KiB (a capped excerpt ends in `…`). */
  sourceHead: string;
  /** `<script>` elements without `src`, plus `on…=` handler attributes. */
  scriptCount: number;
  /** Every external host the page references (`src` / `href` / `url()`). */
  externalHosts: string[];
  /** The scan's fixed sentence (never "0 findings") and its non-blocking counts. */
  scanSentence: string;
  emailCount: number;
  phoneCount: number;
  /** Update only: what the registry recorded for the last publish of this link. */
  previous?: { sha256: string; byteLength?: number; lineCount?: number };
  /**
   * UA1.25 — present only when the card shares a CHAT (the session's Share action, never a tool): what the snapshot
   * did to the transcript before these bytes were built (`share-snapshot.ts`). `sourcePath` is then the chat's title.
   */
  chatShare?: {
    /** Rule name → masked values (never the values). */
    maskedSecrets: Array<{ rule: string; count: number }>;
    maskedSecretTotal: number;
    /** Absolute paths rewritten (relative to the project, or `…/<name>`). */
    relativisedPaths: number;
    /** Tool payloads cut at the snapshot's per-payload cap. */
    truncatedPayloads: number;
  };
}

export interface PermissionRequest {
  /** UA1.18 — present only on the `publish_artifact` card. See {@link ArtifactPublishPermissionRequest}. */
  artifactPublish?: ArtifactPublishPermissionRequest;
}

/**
 * F1.732 — RENDERER-ONLY: this user message was accepted by the host as a STEER into a running
 * turn (the composer's optimistic mid-stream send, answered `accepted`). The host owns a steer
 * after a Stop — it re-queues an undelivered one into the paused queue — so the Stop restore
 * (`composerTextAfterStop`) leaves it there instead of putting a second copy in the draft. Set and
 * cleared only by the renderer's `handleUserMessage`; the host never sends or stores it. Merged here,
 * at the file end, so no docs-cited line above moves.
 */
export interface Message {
  steered?: true;
}

/**
 * UB2.14 — a HIDDEN message: it reaches the model (it drives a turn) but never renders as a transcript
 * bubble. Set only by the host, from `SendMessageOptions.hidden` (`SessionManager.sendMessage`); the one
 * producer today is the source-activation auto-retry, because the user already sees their message and the
 * activation, so the retry must not draw a second copy of it. The renderer drops these rows in
 * `groupMessagesByTurn` (desktop and session viewer); the assistant reply the message drives renders as usual.
 *
 * Ported from craft-agents-oss v0.15.1 `packages/core/src/types/message.ts` (`Message.hidden`,
 * Apache-2.0). Unlike F1.351's `taskNotification` — drawn as a labelled system line because hiding it
 * would leave the model's reaction inexplicable — a hidden row restates what the transcript already shows.
 * Persisted (upstream relies on the mappers' spreads alone; ours also declares it on `StoredMessage`) so a
 * reloaded transcript keeps the row hidden. `true` or absent. Merged here, at the file end, so no
 * docs-cited line above moves.
 */
export interface Message {
  hidden?: true;
}

/** UB2.14 — persisted. See {@link Message.hidden}. */
export interface StoredMessage {
  hidden?: true;
}

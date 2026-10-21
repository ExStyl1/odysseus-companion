/**
 * AutomationHandler Interface and Common Types
 *
 * Defines the contract for all automation handlers in the Event Bus system.
 * Each handler:
 * - Subscribes to relevant events on the bus
 * - Executes its specific logic
 * - Is self-contained and testable in isolation
 */

import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationEvent, AutomationsConfig, AutomationMatcher, PendingPrompt } from '../types.ts';

// ============================================================================
// Handler Interface
// ============================================================================

/**
 * Base interface for all automation handlers.
 * Handlers subscribe to events and process them independently.
 */
export interface AutomationHandler {
  /** Subscribe to events on the bus */
  subscribe(bus: EventBus): void;

  /** Clean up resources and unsubscribe from events */
  dispose(): void | Promise<void>;
}

// ============================================================================
// Handler Options
// ============================================================================

/**
 * Options for creating a PromptHandler.
 *
 * P3.189 — THREE fields were deleted here, and the reason each one is
 * redundant rather than unfinished is written down because all three looked
 * alive: their same-named siblings on the two handler option types below ARE
 * read, which is the *"same-named symbols in a sibling subsystem"* shape from
 * the inert-worklist. `prompt-handler.ts` is 153 lines and reads exactly two
 * options — `sessionId` and `onPromptsReady`.
 *
 * - `workspaceRootPath` (REQUIRED since the baseline commit, read in no code
 *   path): the prompt half of the history IS written, one layer up, by
 *   `SessionManager` (`createPromptHistoryEntry` +
 *   `appendAutomationHistoryEntry`), which owns the path already. Its
 *   siblings feed `AutomationEventLogger` and `RetryScheduler`, which is why
 *   it read as unfinished.
 * - `workspaceId` (required, unread): `EventLogHandlerOptions.workspaceId`
 *   stamps log entries; nothing here stamps anything.
 * - `onError` (optional, unread): this handler has no catch at all, and its
 *   only failure — a throwing `onPromptsReady` — is already caught AND
 *   LOGGED one layer up by `EventBus.emit`'s any-handler wrapper. So the
 *   field was a second reporting path over a failure that is already
 *   reported, not a missing one. Restore it only together with a catch that
 *   calls it.
 *
 * Deleting a field is a production change, which is why the measurement is
 * here and not only in a commit message.
 */
export interface PromptHandlerOptions {
  /** Session ID (if executing in a session context) */
  sessionId?: string;
  /** Called when prompts are ready to be executed */
  onPromptsReady?: (prompts: PendingPrompt[]) => void;
}

/** Options for creating an EventLogHandler */
export interface EventLogHandlerOptions {
  /** Workspace root path for log file location */
  workspaceRootPath: string;
  /** Workspace ID for log entries */
  workspaceId: string;
  /** Called when logging fails after retries */
  onEventLost?: (events: string[], error: Error) => void;
}

// ============================================================================
// Handler Result Types
// ============================================================================

/** Result from prompt processing */
export interface PromptProcessingResult {
  event: AutomationEvent;
  prompts: PendingPrompt[];
  durationMs: number;
}

// ============================================================================
// Config Provider Interface
// ============================================================================

/**
 * Interface for getting automations configuration.
 * Allows handlers to be decoupled from config loading.
 */
export interface AutomationsConfigProvider {
  /** Get the current automations configuration */
  getConfig(): AutomationsConfig | null;

  /** Get matchers for a specific event */
  getMatchersForEvent(event: AutomationEvent): AutomationMatcher[];
}

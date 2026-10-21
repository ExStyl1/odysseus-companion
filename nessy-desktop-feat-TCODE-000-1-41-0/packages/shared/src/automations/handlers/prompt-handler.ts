/**
 * PromptHandler - Processes prompt actions for App events
 *
 * Subscribes to App events and collects prompt actions to be executed.
 * Prompts are queued and delivered via callback for the caller to execute.
 */

import { createLogger } from '../../utils/debug.ts';
import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationHandler, PromptHandlerOptions, AutomationsConfigProvider } from './types.ts';
import { APP_EVENTS, type AutomationEvent, type AutomationMatcher, type PromptAction, type PendingPrompt, type AppEvent } from '../types.ts';
import { matcherMatches, buildEnvFromPayload, expandEnvVars, parsePromptReferences } from '../utils.ts';
import { deriveAutomationName } from '../name-utils.ts';

const log = createLogger('prompt-handler');

/**
 * One matcher the caller has already decided should produce prompts.
 *
 * The selection is the caller's, not this module's, because the two callers
 * select differently and only one of them can use `matcherMatches`: the event
 * path matches the CURRENT event, while the start/wake catch-up sweep
 * (desktop-scheduled-tasks.md:74) has already decided from a persisted cursor
 * that a past occurrence was missed — a replayed `SchedulerTick` would be
 * evaluated against the current minute and match nothing.
 */
export interface AutomationPromptSource {
  readonly matcher: AutomationMatcher;
  /** Epoch ms of the missed occurrence when this is a catch-up run. */
  readonly catchUpForOccurrenceAt?: number;
}

/**
 * Build the `PendingPrompt`s for an already-selected matcher list.
 *
 * Extracted from {@link PromptHandler.handleEvent} so the catch-up sweep emits
 * prompts that are identical in every field — env expansion, `@mention`
 * parsing, label expansion, derived name — instead of a parallel construction
 * that would drift.
 */
export function buildPendingPromptsForMatchers(input: {
  readonly sessionId: string | undefined;
  readonly event: AutomationEvent;
  readonly payload: BaseEventPayload;
  readonly sources: readonly AutomationPromptSource[];
}): PendingPrompt[] {
  const env = buildEnvFromPayload(input.event, input.payload);
  const pendingPrompts: PendingPrompt[] = [];

  for (const { matcher, catchUpForOccurrenceAt } of input.sources) {
    const automationName = deriveAutomationName(input.event, matcher);
    for (const action of matcher.actions) {
      if (action.type !== 'prompt') continue;
      const prompt = action as PromptAction;
      const expandedPrompt = expandEnvVars(prompt.prompt, env);
      const references = parsePromptReferences(expandedPrompt);

      pendingPrompts.push({
        sessionId: input.sessionId,
        matcherId: matcher.id,
        automationName,
        prompt: expandedPrompt,
        mentions: references.mentions,
        labels: matcher.labels?.map(label => expandEnvVars(label, env)),
        permissionMode: matcher.permissionMode,
        // Matcher-level, not action-level: desktop-scheduled-tasks.md:34 makes
        // isolation a property of the task, not of one instruction.
        worktree: matcher.worktree,
        llmConnection: prompt.llmConnection,
        model: prompt.model,
        thinkingLevel: prompt.thinkingLevel,
        ephemeral: prompt.ephemeral,
        catchUpForOccurrenceAt,
        // UB4.8 — ALWAYS, the row's stated divergence from upstream (which sets
        // them only under a semanticCondition): the loop guard reads
        // `eventPayload.sessionId` on every prompt, so a self-labelling matcher
        // with no condition is protected too. Both producers (this handler and
        // the missed-run sweep) reach this one builder, so both carry them.
        event: input.event,
        eventPayload: input.payload as unknown as Record<string, unknown> | undefined,
        // UB6.9 — the matcher's decision-model condition rides the prompt it
        // gates; the host judges it in SessionManager, after the loop guard
        // (upstream v0.15.1 sets it on the pending prompt the same way, only
        // under a condition it also sets event/eventPayload).
        semanticCondition: matcher.semanticCondition,
      });
    }
  }

  return pendingPrompts;
}

// ============================================================================
// PromptHandler Implementation
// ============================================================================

export class PromptHandler implements AutomationHandler {
  private readonly options: PromptHandlerOptions;
  private readonly configProvider: AutomationsConfigProvider;
  private bus: EventBus | null = null;
  private boundHandler: ((event: AutomationEvent, payload: BaseEventPayload) => Promise<void>) | null = null;

  constructor(options: PromptHandlerOptions, configProvider: AutomationsConfigProvider) {
    this.options = options;
    this.configProvider = configProvider;
  }

  /**
   * Subscribe to App events on the bus.
   */
  subscribe(bus: EventBus): void {
    this.bus = bus;
    this.boundHandler = this.handleEvent.bind(this);
    bus.onAny(this.boundHandler);
    log.debug(`[PromptHandler] Subscribed to event bus`);
  }

  /**
   * Handle an event by processing matching prompt actions.
   */
  private async handleEvent(event: AutomationEvent, payload: BaseEventPayload): Promise<void> {
    // Only process App events for prompt actions
    if (!APP_EVENTS.includes(event as AppEvent)) {
      return;
    }

    const matchers = this.configProvider.getMatchersForEvent(event);
    if (matchers.length === 0) return;

    const sources: AutomationPromptSource[] = [];
    for (const matcher of matchers) {
      if (!matcherMatches(matcher, event, payload as unknown as Record<string, unknown>)) continue;
      if (!matcher.actions.some(action => action.type === 'prompt')) continue;
      sources.push({ matcher });
    }

    if (sources.length === 0) return;

    const pendingPrompts = buildPendingPromptsForMatchers({
      sessionId: this.options.sessionId,
      event,
      payload,
      sources,
    });
    log.debug(`[PromptHandler] Processing ${pendingPrompts.length} prompts for ${event}`);

    // Deliver prompts via callback
    if (pendingPrompts.length > 0 && this.options.onPromptsReady) {
      log.debug(`[PromptHandler] Delivering ${pendingPrompts.length} prompts`);
      this.options.onPromptsReady(pendingPrompts);
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.bus && this.boundHandler) {
      this.bus.offAny(this.boundHandler);
      this.boundHandler = null;
    }
    this.bus = null;
    log.debug(`[PromptHandler] Disposed`);
  }
}

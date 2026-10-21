/**
 * Automation Handlers - Re-exports for convenience
 */

export type {
  AutomationHandler,
  PromptHandlerOptions,
  EventLogHandlerOptions,
  PromptProcessingResult,
  AutomationsConfigProvider,
} from './types.ts';

export { PromptHandler, buildPendingPromptsForMatchers, type AutomationPromptSource } from './prompt-handler.ts';
export { EventLogHandler } from './event-log-handler.ts';
export { WebhookHandler, type WebhookHandlerOptions } from './webhook-handler.ts';
// UA8.1 — the script action's App-event handler (craft-agents-oss v0.13.4).
export { ScriptHandler, type ScriptHandlerOptions } from './script-handler.ts';

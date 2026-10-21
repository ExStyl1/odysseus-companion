/**
 * SDK Bridge - Environment variable building for Claude SDK automation integration
 *
 * Maps SDK automation input fields to NESSY_* environment variables for command execution.
 */

import { sanitizeForShell } from './security.ts';
import { cleanEnv } from './utils.ts';
import type { AgentEvent, SdkAutomationInput } from './types.ts';

/**
 * Build environment variables from SDK automation input.
 * Maps SDK input fields to NESSY_* environment variables.
 */
export function buildEnvFromSdkInput(event: AgentEvent, input: SdkAutomationInput): Record<string, string> {
  const env: Record<string, string> = {
    ...cleanEnv(),
    NESSY_EVENT: event,
  };

  // Map SDK input fields to env vars based on event type
  // User-provided values are sanitized to prevent shell injection
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
      if (input.tool_name) env.NESSY_TOOL_NAME = input.tool_name; // Tool names are internal, not user input
      if (input.tool_input) env.NESSY_TOOL_INPUT = sanitizeForShell(JSON.stringify(input.tool_input));
      if (input.tool_response) env.NESSY_TOOL_RESPONSE = sanitizeForShell(input.tool_response);
      break;

    case 'PostToolUseFailure':
      if (input.tool_name) env.NESSY_TOOL_NAME = input.tool_name;
      if (input.tool_input) env.NESSY_TOOL_INPUT = sanitizeForShell(JSON.stringify(input.tool_input));
      if (input.error) env.NESSY_ERROR = sanitizeForShell(input.error);
      break;

    case 'UserPromptSubmit':
      // User prompts are user-controlled and must be sanitized
      if (input.prompt) env.NESSY_PROMPT = sanitizeForShell(input.prompt);
      break;

    case 'SessionStart':
      if (input.source) env.NESSY_SOURCE = input.source; // Internal values
      if (input.model) env.NESSY_MODEL = input.model;
      break;

    case 'SubagentStart':
    case 'SubagentStop':
      if (input.agent_id) env.NESSY_AGENT_ID = input.agent_id; // Internal values
      if (input.agent_type) env.NESSY_AGENT_TYPE = input.agent_type;
      break;

    case 'Notification':
      // hooks.md#notification input: `notification_type` is the documented,
      // closed-vocabulary discriminator; title/message are free text and could
      // contain user data.
      if (input.notification_type) env.NESSY_NOTIFICATION_TYPE = input.notification_type;
      if (input.message) env.NESSY_MESSAGE = sanitizeForShell(input.message);
      if (input.title) env.NESSY_TITLE = sanitizeForShell(input.title);
      break;

    // SessionEnd, Stop and PermissionRequest have no additional fields.
    //
    // PreCompact/PostCompact DO (hooks.md:2784, :2810 — `trigger` plus
    // `custom_instructions` / `compact_summary`) and are deliberately not
    // mirrored here: this builder has NO production caller (the live one is
    // `buildHookCommandEnv` in hook-command.ts, which every hook execution
    // authority shares), and `compact_summary` is unbounded conversation text
    // that already reaches the process whole on stdin and in NESSY_EVENT_DATA.
    // Adding cases here instead of there is the failure mode to avoid: green
    // tests, unchanged behaviour.
    default:
      break;
  }

  return env;
}

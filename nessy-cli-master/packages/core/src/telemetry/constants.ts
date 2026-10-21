/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const SERVICE_NAME = 'nessy-cli';

export const EVENT_USER_PROMPT = 'nessy-cli.user_prompt';
export const EVENT_USER_RETRY = 'nessy-cli.user_retry';
export const EVENT_TOOL_CALL = 'nessy-cli.tool_call';
export const EVENT_API_REQUEST = 'nessy-cli.api_request';
export const EVENT_API_ERROR = 'nessy-cli.api_error';
export const EVENT_API_CANCEL = 'nessy-cli.api_cancel';
export const EVENT_API_RESPONSE = 'nessy-cli.api_response';
export const EVENT_CLI_CONFIG = 'nessy-cli.config';
export const EVENT_EXTENSION_DISABLE = 'nessy-cli.extension_disable';
export const EVENT_EXTENSION_ENABLE = 'nessy-cli.extension_enable';
export const EVENT_EXTENSION_INSTALL = 'nessy-cli.extension_install';
export const EVENT_EXTENSION_UNINSTALL = 'nessy-cli.extension_uninstall';
export const EVENT_EXTENSION_UPDATE = 'nessy-cli.extension_update';
export const EVENT_FLASH_FALLBACK = 'nessy-cli.flash_fallback';
export const EVENT_RIPGREP_FALLBACK = 'nessy-cli.ripgrep_fallback';
export const EVENT_NEXT_SPEAKER_CHECK = 'nessy-cli.next_speaker_check';
export const EVENT_SLASH_COMMAND = 'nessy-cli.slash_command';
export const EVENT_IDE_CONNECTION = 'nessy-cli.ide_connection';
export const EVENT_CHAT_COMPRESSION = 'nessy-cli.chat_compression';
export const EVENT_INVALID_CHUNK = 'nessy-cli.chat.invalid_chunk';
export const EVENT_CONTENT_RETRY = 'nessy-cli.chat.content_retry';
export const EVENT_CONTENT_RETRY_FAILURE =
  'nessy-cli.chat.content_retry_failure';
// Phase 4b — HTTP-status retry telemetry emitted by `retryWithBackoff` for
// 429 / 5xx errors at LLM call sites. Distinct from EVENT_CONTENT_RETRY,
// which is fired by geminiChat for InvalidStreamError retries on a separate
// retry budget. See docs/design/telemetry-llm-request-timing-design.md.
export const EVENT_API_RETRY = 'nessy-cli.api_retry';
export const EVENT_CONVERSATION_FINISHED = 'nessy-cli.conversation_finished';
export const EVENT_MALFORMED_JSON_RESPONSE =
  'nessy-cli.malformed_json_response';
export const EVENT_FILE_OPERATION = 'nessy-cli.file_operation';
export const EVENT_MODEL_SLASH_COMMAND = 'nessy-cli.slash_command.model';
export const EVENT_SUBAGENT_EXECUTION = 'nessy-cli.subagent_execution';
export const EVENT_SKILL_LAUNCH = 'nessy-cli.skill_launch';
export const EVENT_AUTH = 'nessy-cli.auth';
export const EVENT_USER_FEEDBACK = 'nessy-cli.user_feedback';

// Prompt Suggestion Events
export const EVENT_PROMPT_SUGGESTION = 'nessy-cli.prompt_suggestion';
export const EVENT_SPECULATION = 'nessy-cli.speculation';

// Workflow Events (#4721)
export const EVENT_WORKFLOW_KEYWORD = 'nessy-cli.workflow_keyword';
export const EVENT_WORKFLOW_RUN = 'nessy-cli.workflow_run';

// Arena Events
export const EVENT_ARENA_SESSION_STARTED = 'nessy-cli.arena_session_started';
export const EVENT_ARENA_AGENT_COMPLETED = 'nessy-cli.arena_agent_completed';
export const EVENT_ARENA_SESSION_ENDED = 'nessy-cli.arena_session_ended';

// Performance Events
export const EVENT_STARTUP_PERFORMANCE = 'nessy-cli.startup.performance';
export const EVENT_MEMORY_USAGE = 'nessy-cli.memory.usage';
export const EVENT_PERFORMANCE_BASELINE = 'nessy-cli.performance.baseline';
export const EVENT_PERFORMANCE_REGRESSION = 'nessy-cli.performance.regression';

// Managed Auto-Memory Events
export const EVENT_MEMORY_EXTRACT = 'nessy-cli.memory.extract';
export const EVENT_MEMORY_DREAM = 'nessy-cli.memory.dream';
export const EVENT_MEMORY_RECALL = 'nessy-cli.memory.recall';

// Session Tracing Span Names
export const SPAN_INTERACTION = 'nessy-cli.interaction';
export const SPAN_LLM_REQUEST = 'nessy-cli.llm_request';
export const SPAN_TOOL = 'nessy-cli.tool';
export const SPAN_TOOL_EXECUTION = 'nessy-cli.tool.execution';
/** Brackets the time a tool spends in `awaiting_approval` waiting on the user. */
export const SPAN_TOOL_BLOCKED_ON_USER = 'nessy-cli.tool.blocked_on_user';
/** Wraps each pre/post-tool-use hook fire site for per-hook latency / decision tracking. */
export const SPAN_HOOK = 'nessy-cli.hook';
/**
 * Wraps a single subagent invocation. Parents the LLM/tool/hook spans the
 * subagent emits, so concurrent subagents (parallel AGENT tool calls) get
 * isolated subtrees instead of interleaving under the parent interaction
 * (#3731 Phase 3).
 */
export const SPAN_SUBAGENT = 'nessy-cli.subagent';

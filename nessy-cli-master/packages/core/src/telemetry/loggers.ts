/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LogAttributes, LogRecord } from '@opentelemetry/api-logs';
import { logs } from '@opentelemetry/api-logs';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { ApprovalMode } from '../config/approvalMode.js';
import type { Config } from '../config/config.js';
import { getAgentLaunchMode } from './statistClient.js';
import { isInternalPromptId } from '../utils/internalPromptIds.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import {
  recordStartupFinished,
  recordAgentMessage,
  recordCounter,
  recordCompletionFailureReason,
  recordPluginInstall,
  getStatistClient,
  getStatistUserId,
  // FeatureCallType,
  // FeatureCallStatus,
  AgentMessageStatus,
  CounterGroup,
} from './index.js';
import { getNessyDlh } from './nessy-dlh/index.js';
import {
  resolveMcpExtensionInfo,
  resolveSkillExtensionInfo,
  resolveSubagentExtensionInfo,
  resolveCommandExtensionInfo,
} from './nessy-dlh/extension-info.js';
import { subagentNameContext } from '../utils/subagentNameContext.js';
import {
  getCurrentDlhContext,
  getDlhParentPromptId,
  getDlhParentToolCallId,
} from './nessy-dlh/dlh-context.js';
import {
  isRecallMemoryInference,
  type InferenceType,
} from './nessy-dlh/inference-type-context.js';
import type { Part } from '@google/genai';
import type { CompletedToolCall } from '../core/coreToolScheduler.js';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import { ToolNames } from '../tools/tool-names.js';
import { getDecisionFromOutcome } from './tool-call-decision.js';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import {
  EVENT_API_ERROR,
  EVENT_API_CANCEL,
  EVENT_API_REQUEST,
  EVENT_API_RESPONSE,
  EVENT_CLI_CONFIG,
  EVENT_EXTENSION_UNINSTALL,
  EVENT_EXTENSION_ENABLE,
  EVENT_IDE_CONNECTION,
  EVENT_TOOL_CALL,
  EVENT_USER_PROMPT,
  EVENT_USER_RETRY,
  EVENT_FLASH_FALLBACK,
  EVENT_NEXT_SPEAKER_CHECK,
  SERVICE_NAME,
  EVENT_SLASH_COMMAND,
  EVENT_CONVERSATION_FINISHED,
  EVENT_CHAT_COMPRESSION,
  EVENT_CONTENT_RETRY,
  EVENT_CONTENT_RETRY_FAILURE,
  EVENT_API_RETRY,
  EVENT_FILE_OPERATION,
  EVENT_RIPGREP_FALLBACK,
  EVENT_EXTENSION_INSTALL,
  EVENT_MODEL_SLASH_COMMAND,
  EVENT_EXTENSION_DISABLE,
  EVENT_SUBAGENT_EXECUTION,
  EVENT_MALFORMED_JSON_RESPONSE,
  EVENT_INVALID_CHUNK,
  EVENT_AUTH,
  EVENT_SKILL_LAUNCH,
  EVENT_EXTENSION_UPDATE,
  EVENT_USER_FEEDBACK,
  EVENT_ARENA_SESSION_STARTED,
  EVENT_ARENA_AGENT_COMPLETED,
  EVENT_ARENA_SESSION_ENDED,
  EVENT_PROMPT_SUGGESTION,
  EVENT_SPECULATION,
  EVENT_WORKFLOW_KEYWORD,
  EVENT_WORKFLOW_RUN,
  EVENT_MEMORY_EXTRACT,
  EVENT_MEMORY_DREAM,
  EVENT_MEMORY_RECALL,
} from './constants.js';
import {
  recordApiErrorMetrics,
  recordApiResponseMetrics,
  recordChatCompressionMetrics,
  recordContentRetry,
  recordContentRetryFailure,
  recordApiRetry,
  recordFileOperationMetric,
  recordInvalidChunk,
  recordModelSlashCommand,
  recordSubagentExecutionMetrics,
  recordTokenUsageMetrics,
  recordToolCallMetrics,
  recordArenaSessionStartedMetrics,
  recordArenaAgentCompletedMetrics,
  recordArenaSessionEndedMetrics,
  recordMemoryExtractMetrics,
  recordMemoryDreamMetrics,
  recordMemoryRecallMetrics,
} from './metrics.js';
import { NessyLogger } from './nessy-logger/nessy-logger.js';
import { isTelemetrySdkInitialized } from './sdk.js';
import type {
  ApiErrorEvent,
  ApiCancelEvent,
  ApiRequestEvent,
  ApiResponseEvent,
  FileOperationEvent,
  IdeConnectionEvent,
  StartSessionEvent,
  ToolCallEvent,
  UserPromptEvent,
  UserRetryEvent,
  FlashFallbackEvent,
  NextSpeakerCheckEvent,
  LoopDetectedEvent,
  LoopDetectionDisabledEvent,
  SlashCommandEvent,
  ConversationFinishedEvent,
  KittySequenceOverflowEvent,
  ChatCompressionEvent,
  ContentRetryEvent,
  ContentRetryFailureEvent,
  ApiRetryEvent,
  RipgrepFallbackEvent,
  ToolOutputTruncatedEvent,
  ExtensionDisableEvent,
  ExtensionEnableEvent,
  ExtensionUninstallEvent,
  ExtensionUpdateEvent,
  ExtensionInstallEvent,
  ModelSlashCommandEvent,
  SubagentExecutionEvent,
  MalformedJsonResponseEvent,
  InvalidChunkEvent,
  AuthEvent,
  SkillLaunchEvent,
  UserFeedbackEvent,
  ArenaSessionStartedEvent,
  ArenaAgentCompletedEvent,
  ArenaSessionEndedEvent,
  PromptSuggestionEvent,
  SpeculationEvent,
  WorkflowKeywordEvent,
  WorkflowRunEvent,
  MemoryExtractEvent,
  MemoryDreamEvent,
  MemoryRecallEvent,
} from './types.js';
import type { HookCallEvent } from './types.js';
import type { UiEvent } from './uiTelemetry.js';
import { uiTelemetryService } from './uiTelemetry.js';
import { recordTokenUsageFromApiResponseBestEffort } from '../services/tokenUsageService.js';

const shouldLogUserPrompts = (config: Config): boolean =>
  config.getTelemetryLogPromptsEnabled();

const getAgentWorkMode = (config: Config): 'act' | 'plan' =>
  config.getApprovalMode() === ApprovalMode.PLAN ? 'plan' : 'act';

function getCommonAttributes(config: Config): LogAttributes {
  return {
    'session.id': config.getSessionId(),
  };
}

export { getCommonAttributes };

export function logStartSession(
  config: Config,
  event: StartSessionEvent,
): void {
  NessyLogger.getInstance(config)?.logStartSessionEvent(event);
  // Отправляем событие Statist независимо от OpenTelemetry
  if (getStatistClient()) {
    recordStartupFinished(config, getStatistUserId());
  }
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_CLI_CONFIG,
    'event.timestamp': new Date().toISOString(),
    model: event.model,
    sandbox_enabled: event.sandbox_enabled,
    core_tools_enabled: event.core_tools_enabled,
    approval_mode: event.approval_mode,
    file_filtering_respect_git_ignore: event.file_filtering_respect_git_ignore,
    debug_mode: event.debug_enabled,
    truncate_tool_output_threshold: event.truncate_tool_output_threshold,
    truncate_tool_output_lines: event.truncate_tool_output_lines,
    mcp_servers: event.mcp_servers,
    mcp_servers_count: event.mcp_servers_count,
    mcp_tools: event.mcp_tools,
    mcp_tools_count: event.mcp_tools_count,
    hooks: event.hooks,
    ide_enabled: event.ide_enabled,
    interactive_shell_enabled: event.interactive_shell_enabled,
    output_format: event.output_format,
    skills: event.skills,
    subagents: event.subagents,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: 'CLI configuration loaded.',
    attributes,
  };
  logger.emit(logRecord);
}

export function logUserPrompt(config: Config, event: UserPromptEvent): void {
  NessyLogger.getInstance(config)?.logNewPromptEvent(event);
  getNessyDlh()?.emit('message', {
    session_id: config.getSessionId(),
    prompt_id: event.prompt_id,
    role: 'user',
    content: event.prompt ?? '',
    include_content: shouldLogUserPrompts(config),
    sensitive_data_filtered: false,
  });
  // Отправляем событие Statist независимо от OpenTelemetry
  if (getStatistClient()) {
    recordAgentMessage(
      config,
      getStatistUserId(),
      AgentMessageStatus.Requested,
      config.getCliVersion() || 'unknown',
      [],
      '',
      event.prompt_id ?? '',
      'text',
      getAgentWorkMode(config),
      config.getSessionId(),
      'user',
      config.getModel(),
    );
  }
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_USER_PROMPT,
    'event.timestamp': new Date().toISOString(),
    prompt_length: event.prompt_length,
    prompt_id: event.prompt_id,
  };

  if (event.auth_type) {
    attributes['auth_type'] = event.auth_type;
  }

  if (shouldLogUserPrompts(config)) {
    attributes['prompt'] = event.prompt;
  }

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `User prompt. Length: ${event.prompt_length}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logUserRetry(config: Config, event: UserRetryEvent): void {
  NessyLogger.getInstance(config)?.logRetryEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_USER_RETRY,
    'event.timestamp': new Date().toISOString(),
    prompt_id: event.prompt_id,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `User retry.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logToolCall(config: Config, event: ToolCallEvent): void {
  const uiEvent = {
    ...event,
    'event.name': EVENT_TOOL_CALL,
    'event.timestamp': new Date().toISOString(),
  } as UiEvent;
  uiTelemetryService.addEvent(uiEvent, config.getSessionId());
  if (!isInternalPromptId(event.prompt_id)) {
    config.getChatRecordingService()?.recordUiTelemetryEvent(uiEvent);
  }
  NessyLogger.getInstance(config)?.logToolCallEvent(event);
  // Отправляем событие Statist независимо от OpenTelemetry
  if (getStatistClient()) {
    // Определяем статус вызова
    let agentMessageStatus: AgentMessageStatus;
    if (event.status === 'success') {
      agentMessageStatus = AgentMessageStatus.Succeeded;
    } else if (event.status === 'error') {
      agentMessageStatus = AgentMessageStatus.Failed;
    } else if (event.status === 'cancelled') {
      agentMessageStatus = AgentMessageStatus.Aborted;
    } else {
      agentMessageStatus = AgentMessageStatus.Requested;
    }

    recordAgentMessage(
      config,
      getStatistUserId(),
      agentMessageStatus,
      config.getCliVersion() || 'unknown',
      [], // abGroups - пустой массив для nessy-cli
      '', // lang
      event.prompt_id ?? '', // requestId
      event.function_name ?? '', // messageType - имя инструмента
      getAgentWorkMode(config), // mode - режим работы агента
      config.getSessionId(), // chatId
      'assistant',
    );
  }
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_TOOL_CALL,
    'event.timestamp': new Date().toISOString(),
    function_args: safeJsonStringify(event.function_args, 2),
  };
  if (event.error) {
    attributes['error.message'] = event.error;
    if (event.error_type) {
      attributes['error.type'] = event.error_type;
    }
  }

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Tool call: ${event.function_name}${event.decision ? `. Decision: ${event.decision}` : ''}. Success: ${event.success}. Duration: ${event.duration_ms}ms.`,
    attributes,
  };
  logger.emit(logRecord);
  recordToolCallMetrics(config, event.duration_ms, {
    function_name: event.function_name,
    success: event.success,
    decision: event.decision,
    tool_type: event.tool_type,
  });
}

export function logToolOutputTruncated(
  config: Config,
  event: ToolOutputTruncatedEvent,
): void {
  NessyLogger.getInstance(config)?.logToolOutputTruncatedEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': 'tool_output_truncated',
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Tool output truncated for ${event.tool_name}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logFileOperation(
  config: Config,
  event: FileOperationEvent,
): void {
  NessyLogger.getInstance(config)?.logFileOperationEvent(event);
  // Отправляем событие Statist независимо от OpenTelemetry
  if (getStatistClient()) {
    recordCounter(
      config,
      getStatistUserId(),
      CounterGroup.EditCode,
      `file_${event.operation}`,
    );
  }
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_FILE_OPERATION,
    'event.timestamp': new Date().toISOString(),
    tool_name: event.tool_name,
    operation: event.operation,
  };

  if (event.lines) {
    attributes['lines'] = event.lines;
  }
  if (event.mimetype) {
    attributes['mimetype'] = event.mimetype;
  }
  if (event.extension) {
    attributes['extension'] = event.extension;
  }
  if (event.programming_language) {
    attributes['programming_language'] = event.programming_language;
  }

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `File operation: ${event.operation}. Lines: ${event.lines}.`,
    attributes,
  };
  logger.emit(logRecord);

  recordFileOperationMetric(config, {
    operation: event.operation,
    lines: event.lines,
    mimetype: event.mimetype,
    extension: event.extension,
    programming_language: event.programming_language,
  });
}

export function logApiRequest(config: Config, event: ApiRequestEvent): void {
  // NessyLogger.getInstance(config)?.logApiRequestEvent(event);
  // Отправляем событие Statist независимо от OpenTelemetry
  if (getStatistClient()) {
    recordAgentMessage(
      config,
      getStatistUserId(),
      AgentMessageStatus.Requested,
      config.getCliVersion() || 'unknown',
      [],
      '',
      event.prompt_id ?? '',
      'text',
      getAgentWorkMode(config),
      config.getSessionId(),
      'user',
      event.model,
    );
  }
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_API_REQUEST,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `API request to ${event.model}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logFlashFallback(
  config: Config,
  event: FlashFallbackEvent,
): void {
  NessyLogger.getInstance(config)?.logFlashFallbackEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_FLASH_FALLBACK,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Switching to flash as Fallback.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logRipgrepFallback(
  config: Config,
  event: RipgrepFallbackEvent,
): void {
  NessyLogger.getInstance(config)?.logRipgrepFallbackEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_RIPGREP_FALLBACK,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Switching to grep as fallback.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logApiError(config: Config, event: ApiErrorEvent): void {
  const uiEvent = {
    ...event,
    'event.name': EVENT_API_ERROR,
    'event.timestamp': new Date().toISOString(),
  } as UiEvent;
  uiTelemetryService.addEvent(uiEvent, config.getSessionId());
  if (!isInternalPromptId(event.prompt_id)) {
    config.getChatRecordingService()?.recordUiTelemetryEvent(uiEvent);
  }
  NessyLogger.getInstance(config)?.logApiErrorEvent(event);
  // Отправляем событие Statist независимо от OpenTelemetry
  if (getStatistClient()) {
    recordAgentMessage(
      config,
      getStatistUserId(),
      AgentMessageStatus.Failed,
      config.getCliVersion() || 'unknown',
      [],
      '',
      event.prompt_id ?? '',
      'text',
      getAgentWorkMode(config),
      config.getSessionId(),
      'assistant',
      event.model,
    );
    recordCompletionFailureReason(
      config,
      process.platform,
      event.error_message,
      `/api/${event.model}`, // Пример пути API
      event.status_code?.toString(),
    );
  }
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_API_ERROR,
    'event.timestamp': new Date().toISOString(),
    ['error.message']: event.error_message,
    model_name: event.model,
    duration: event.duration_ms,
  };

  if (event.error_type) {
    attributes['error.type'] = event.error_type;
  }
  if (typeof event.status_code === 'number') {
    attributes[SemanticAttributes.HTTP_STATUS_CODE] = event.status_code;
  }

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `API error for ${event.model}. Error: ${event.error_message}. Duration: ${event.duration_ms}ms.`,
    attributes,
  };
  logger.emit(logRecord);
  recordApiErrorMetrics(config, event.duration_ms, {
    model: event.model,
    status_code: event.status_code,
    error_type: event.error_type,
  });
}

export function logApiCancel(config: Config, event: ApiCancelEvent): void {
  const uiEvent = {
    ...event,
    'event.name': EVENT_API_CANCEL,
    'event.timestamp': new Date().toISOString(),
  } as UiEvent;
  uiTelemetryService.addEvent(uiEvent, config.getSessionId());
  NessyLogger.getInstance(config)?.logApiCancelEvent(event);
  // Отправляем событие Statist независимо от OpenTelemetry
  if (getStatistClient()) {
    recordAgentMessage(
      config,
      getStatistUserId(),
      AgentMessageStatus.Aborted,
      config.getCliVersion() || 'unknown',
      [],
      '',
      event.prompt_id ?? '',
      'text',
      getAgentWorkMode(config),
      config.getSessionId(),
      'assistant',
      event.model,
    );
  }
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_API_CANCEL,
    'event.timestamp': new Date().toISOString(),
    model_name: event.model,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `API request cancelled for ${event.model}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logApiResponse(config: Config, event: ApiResponseEvent): void {
  const uiEvent = {
    ...event,
    'event.name': EVENT_API_RESPONSE,
    'event.timestamp': new Date().toISOString(),
  } as UiEvent;
  uiTelemetryService.addEvent(uiEvent, config.getSessionId());
  if (!isInternalPromptId(event.prompt_id)) {
    if (config.getUsageStatisticsEnabled()) {
      recordTokenUsageFromApiResponseBestEffort(config, event);
    }
    config.getChatRecordingService()?.recordUiTelemetryEvent(uiEvent);
  }
  NessyLogger.getInstance(config)?.logApiResponseEvent(event);
  // Отправляем событие Statist независимо от OpenTelemetry
  if (getStatistClient()) {
    recordAgentMessage(
      config,
      getStatistUserId(),
      AgentMessageStatus.Succeeded,
      config.getCliVersion() || 'unknown',
      [],
      '',
      event.prompt_id ?? '',
      'text',
      getAgentWorkMode(config),
      config.getSessionId(),
      'assistant',
      event.model,
    );
  }
  if (!isTelemetrySdkInitialized()) return;
  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_API_RESPONSE,
    'event.timestamp': new Date().toISOString(),
  };
  if (event.response_text) {
    attributes['response_text'] = event.response_text;
  }
  if (event.status_code) {
    if (typeof event.status_code === 'number') {
      attributes[SemanticAttributes.HTTP_STATUS_CODE] = event.status_code;
    }
  }

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `API response from ${event.model}. Status: ${event.status_code || 'N/A'}. Duration: ${event.duration_ms}ms.`,
    attributes,
  };
  logger.emit(logRecord);
  recordApiResponseMetrics(config, event.duration_ms, {
    model: event.model,
    status_code: event.status_code,
  });
  recordTokenUsageMetrics(config, event.input_token_count, {
    model: event.model,
    type: 'input',
  });
  recordTokenUsageMetrics(config, event.output_token_count, {
    model: event.model,
    type: 'output',
  });
  recordTokenUsageMetrics(config, event.cached_content_token_count, {
    model: event.model,
    type: 'cache',
  });
  recordTokenUsageMetrics(config, event.thoughts_token_count, {
    model: event.model,
    type: 'thought',
  });
}

export function logLoopDetected(
  config: Config,
  event: LoopDetectedEvent,
): void {
  NessyLogger.getInstance(config)?.logLoopDetectedEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Loop detected. Type: ${event.loop_type}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logLoopDetectionDisabled(
  config: Config,
  _event: LoopDetectionDisabledEvent,
): void {
  NessyLogger.getInstance(config)?.logLoopDetectionDisabledEvent();
}

export function logNextSpeakerCheck(
  config: Config,
  event: NextSpeakerCheckEvent,
): void {
  NessyLogger.getInstance(config)?.logNextSpeakerCheck(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_NEXT_SPEAKER_CHECK,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Next speaker check.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logSlashCommand(
  config: Config,
  event: SlashCommandEvent,
): void {
  NessyLogger.getInstance(config)?.logSlashCommandEvent(event);

  // [nessy-fork] dlh-telemetry — resolve extension attribution from the command
  // name (fork-owned scan of active extensions); no upstream event/threading.
  const slashExtension = resolveCommandExtensionInfo(config, event.command);
  getNessyDlh()?.emit('slash_command', {
    command: event.command,
    subcommand: event.subcommand,
    extension_name: slashExtension.extension_name,
    extension_source: slashExtension.extension_source,
  });

  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_SLASH_COMMAND,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Slash command: ${event.command}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logIdeConnection(
  config: Config,
  event: IdeConnectionEvent,
): void {
  NessyLogger.getInstance(config)?.logIdeConnectionEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_IDE_CONNECTION,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Ide connection. Type: ${event.connection_type}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logConversationFinishedEvent(
  config: Config,
  event: ConversationFinishedEvent,
): void {
  NessyLogger.getInstance(config)?.logConversationFinishedEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_CONVERSATION_FINISHED,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Conversation finished.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logChatCompression(
  config: Config,
  event: ChatCompressionEvent,
): void {
  NessyLogger.getInstance(config)?.logChatCompressionEvent(event);

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_CHAT_COMPRESSION,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Chat compression (Saved ${event.tokens_before - event.tokens_after} tokens)`,
    attributes,
  };
  logger.emit(logRecord);

  recordChatCompressionMetrics(config, {
    tokens_before: event.tokens_before,
    tokens_after: event.tokens_after,
  });
}

export function logKittySequenceOverflow(
  config: Config,
  event: KittySequenceOverflowEvent,
): void {
  NessyLogger.getInstance(config)?.logKittySequenceOverflowEvent(event);
  if (!isTelemetrySdkInitialized()) return;
  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
  };
  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Kitty sequence buffer overflow: ${event.sequence_length} bytes`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logMalformedJsonResponse(
  config: Config,
  event: MalformedJsonResponseEvent,
): void {
  NessyLogger.getInstance(config)?.logMalformedJsonResponseEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_MALFORMED_JSON_RESPONSE,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Malformed JSON response from ${event.model}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logInvalidChunk(
  config: Config,
  event: InvalidChunkEvent,
): void {
  NessyLogger.getInstance(config)?.logInvalidChunkEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_INVALID_CHUNK,
    'event.timestamp': event['event.timestamp'],
  };

  if (event.error_message) {
    attributes['error.message'] = event.error_message;
  }

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Invalid chunk received from stream.`,
    attributes,
  };
  logger.emit(logRecord);
  recordInvalidChunk(config);
}

export function logContentRetry(
  config: Config,
  event: ContentRetryEvent,
): void {
  NessyLogger.getInstance(config)?.logContentRetryEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_CONTENT_RETRY,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Content retry attempt ${event.attempt_number} due to ${event.error_type}.`,
    attributes,
  };
  logger.emit(logRecord);
  recordContentRetry(config);
}

export function logContentRetryFailure(
  config: Config,
  event: ContentRetryFailureEvent,
): void {
  NessyLogger.getInstance(config)?.logContentRetryFailureEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_CONTENT_RETRY_FAILURE,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `All content retries failed after ${event.total_attempts} attempts.`,
    attributes,
  };
  logger.emit(logRecord);
  recordContentRetryFailure(config);
}

/**
 * Phase 4b — Emits an HTTP-status retry event fired from `retryWithBackoff`
 * at an LLM call site (via the `onRetry` callback opt-in). Distinct from
 * `logContentRetry`, which is fired by `geminiChat`'s content-recovery loop.
 *
 * Three-sink fan-out, matching the `logContentRetry` shape exactly:
 *   1. NessyLogger RUM ingestion (Aliyun internal stats)
 *   2. OTel log signal via `logger.emit()` — picked up by LogToSpanProcessor
 *      and bridged to a span sibling under the caller's active span (typically
 *      interaction or tool, NOT the failed LLM span — that span has already
 *      ended by the time onRetry fires).
 *   3. `recordApiRetry` Counter increment for per-model retry-rate dashboards.
 */
export function logApiRetry(config: Config, event: ApiRetryEvent): void {
  NessyLogger.getInstance(config)?.logApiRetryEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_API_RETRY,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `API retry attempt ${event.attempt_number} for ${event.model} (status ${event.status_code ?? 'unknown'}).`,
    attributes,
  };
  logger.emit(logRecord);
  recordApiRetry(config, { model: event.model });
}

export function logSubagentExecution(
  config: Config,
  event: SubagentExecutionEvent,
): void {
  NessyLogger.getInstance(config)?.logSubagentExecutionEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_SUBAGENT_EXECUTION,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Subagent execution: ${event.subagent_name}.`,
    attributes,
  };
  logger.emit(logRecord);
  recordSubagentExecutionMetrics(
    config,
    event.subagent_name,
    event.status,
    event.terminate_reason,
  );
}

export function logModelSlashCommand(
  config: Config,
  event: ModelSlashCommandEvent,
): void {
  NessyLogger.getInstance(config)?.logModelSlashCommandEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_MODEL_SLASH_COMMAND,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Model slash command. Model: ${event.model_name}`,
    attributes,
  };
  logger.emit(logRecord);
  recordModelSlashCommand(config, event);
}

export function logHookCall(config: Config, event: HookCallEvent): void {
  // Log to NessyLogger for RUM telemetry only
  NessyLogger.getInstance(config)?.logHookCallEvent(event);
}

export function logExtensionInstallEvent(
  config: Config,
  event: ExtensionInstallEvent,
): void {
  NessyLogger.getInstance(config)?.logExtensionInstallEvent(event);
  // [nessy-fork] statist-plugin-install — отливаем установку расширения в
  // Statist (проект Marketplace) независимо от OpenTelemetry.
  if (getStatistClient()) {
    recordPluginInstall(
      config,
      getStatistUserId(),
      event.extension_source,
      event.status,
    );
  }
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_EXTENSION_INSTALL,
    'event.timestamp': new Date().toISOString(),
    extension_name: event.extension_name,
    extension_version: event.extension_version,
    extension_source: event.extension_source,
    status: event.status,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Installed extension ${event.extension_name}`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logExtensionUninstall(
  config: Config,
  event: ExtensionUninstallEvent,
): void {
  NessyLogger.getInstance(config)?.logExtensionUninstallEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_EXTENSION_UNINSTALL,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Uninstalled extension ${event.extension_name}`,
    attributes,
  };
  logger.emit(logRecord);
}

export async function logExtensionUpdateEvent(
  config: Config,
  event: ExtensionUpdateEvent,
): Promise<void> {
  NessyLogger.getInstance(config)?.logExtensionUpdateEvent(event);

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_EXTENSION_UPDATE,
    'event.timestamp': new Date().toISOString(),
    extension_name: event.extension_name,
    extension_id: event.extension_id,
    extension_previous_version: event.extension_previous_version,
    extension_version: event.extension_version,
    extension_source: event.extension_source,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Updated extension ${event.extension_name} from ${event.extension_previous_version} to ${event.extension_version}`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logExtensionEnable(
  config: Config,
  event: ExtensionEnableEvent,
): void {
  NessyLogger.getInstance(config)?.logExtensionEnableEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_EXTENSION_ENABLE,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Enabled extension ${event.extension_name}`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logExtensionDisable(
  config: Config,
  event: ExtensionDisableEvent,
): void {
  NessyLogger.getInstance(config)?.logExtensionDisableEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_EXTENSION_DISABLE,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Disabled extension ${event.extension_name}`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logAuth(config: Config, event: AuthEvent): void {
  NessyLogger.getInstance(config)?.logAuthEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_AUTH,
    'event.timestamp': new Date().toISOString(),
    auth_type: event.auth_type,
    action_type: event.action_type,
    status: event.status,
  };

  if (event.error_message) {
    attributes['error.message'] = event.error_message;
  }

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Auth event: ${event.action_type} ${event.status} for ${event.auth_type}`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logSkillLaunch(config: Config, event: SkillLaunchEvent): void {
  NessyLogger.getInstance(config)?.logSkillLaunchEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_SKILL_LAUNCH,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Skill launch: ${event.skill_name}. Success: ${event.success}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logUserFeedback(
  config: Config,
  event: UserFeedbackEvent,
): void {
  const uiEvent = {
    ...event,
    'event.name': EVENT_USER_FEEDBACK,
    'event.timestamp': new Date().toISOString(),
  } as UiEvent;
  uiTelemetryService.addEvent(uiEvent, config.getSessionId());
  config.getChatRecordingService()?.recordUiTelemetryEvent(uiEvent);
  NessyLogger.getInstance(config)?.logUserFeedbackEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_USER_FEEDBACK,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `User feedback: Rating ${event.rating} for session ${event.session_id}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logArenaSessionStarted(
  config: Config,
  event: ArenaSessionStartedEvent,
): void {
  NessyLogger.getInstance(config)?.logArenaSessionStartedEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    model_ids: JSON.stringify(event.model_ids),
    'event.name': EVENT_ARENA_SESSION_STARTED,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Arena session started. Agents: ${event.model_ids.length}.`,
    attributes,
  };
  logger.emit(logRecord);
  recordArenaSessionStartedMetrics(config);
}

export function logArenaAgentCompleted(
  config: Config,
  event: ArenaAgentCompletedEvent,
): void {
  NessyLogger.getInstance(config)?.logArenaAgentCompletedEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_ARENA_AGENT_COMPLETED,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Arena agent ${event.agent_model_id} ${event.status}. Duration: ${event.duration_ms}ms. Tokens: ${event.total_tokens}.`,
    attributes,
  };
  logger.emit(logRecord);
  recordArenaAgentCompletedMetrics(
    config,
    event.agent_model_id,
    event.status,
    event.duration_ms,
    event.input_tokens,
    event.output_tokens,
  );
}

export function logArenaSessionEnded(
  config: Config,
  event: ArenaSessionEndedEvent,
): void {
  NessyLogger.getInstance(config)?.logArenaSessionEndedEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_ARENA_SESSION_ENDED,
    'event.timestamp': new Date().toISOString(),
  };

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Arena session ended: ${event.status}.${event.winner_model_id ? ` Winner: ${event.winner_model_id}.` : ''}`,
    attributes,
  };
  logger.emit(logRecord);
  recordArenaSessionEndedMetrics(
    config,
    event.status,
    event.display_backend,
    event.duration_ms,
    event.winner_model_id,
  );
}

export function logPromptSuggestion(
  config: Config,
  event: PromptSuggestionEvent,
): void {
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_PROMPT_SUGGESTION,
    'event.timestamp': event['event.timestamp'],
    outcome: event.outcome,
  };

  if (event.prompt_id) {
    attributes['prompt_id'] = event.prompt_id;
  }
  if (event.accept_method) {
    attributes['accept_method'] = event.accept_method;
  }
  if (event.accept_source) {
    attributes['accept_source'] = event.accept_source;
  }
  if (event.time_to_accept_ms !== undefined) {
    attributes['time_to_accept_ms'] = event.time_to_accept_ms;
  }
  if (event.time_to_ignore_ms !== undefined) {
    attributes['time_to_ignore_ms'] = event.time_to_ignore_ms;
  }
  if (event.time_to_first_keystroke_ms !== undefined) {
    attributes['time_to_first_keystroke_ms'] = event.time_to_first_keystroke_ms;
  }
  if (event.suggestion_length !== undefined) {
    attributes['suggestion_length'] = event.suggestion_length;
  }
  if (event.similarity !== undefined) {
    attributes['similarity'] = event.similarity;
  }
  if (event.was_focused_when_shown !== undefined) {
    attributes['was_focused_when_shown'] = event.was_focused_when_shown;
  }
  if (event.reason) {
    attributes['reason'] = event.reason;
  }

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Prompt suggestion: ${event.outcome}.`,
    attributes,
  };
  logger.emit(logRecord);
}

export function logSpeculation(config: Config, event: SpeculationEvent): void {
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_SPECULATION,
    'event.timestamp': event['event.timestamp'],
    outcome: event.outcome,
    turns_used: event.turns_used,
    files_written: event.files_written,
    tool_use_count: event.tool_use_count,
    duration_ms: event.duration_ms,
    had_pipelined_suggestion: event.had_pipelined_suggestion,
  };

  if (event.boundary_type) {
    attributes['boundary_type'] = event.boundary_type;
  }

  const logger = logs.getLogger(SERVICE_NAME);
  const logRecord: LogRecord = {
    body: `Speculation: ${event.outcome}.`,
    attributes,
  };
  logger.emit(logRecord);
}

// ─── Workflow Log Functions (#4721) ──────────────────────────────────────────

export function logWorkflowKeyword(
  config: Config,
  event: WorkflowKeywordEvent,
): void {
  if (!isTelemetrySdkInitialized()) return;
  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_WORKFLOW_KEYWORD,
    'event.timestamp': event['event.timestamp'],
  };
  const logger = logs.getLogger(SERVICE_NAME);
  logger.emit({ body: 'Workflow keyword trigger fired.', attributes });
}

export function logWorkflowRun(config: Config, event: WorkflowRunEvent): void {
  if (!isTelemetrySdkInitialized()) return;
  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_WORKFLOW_RUN,
    'event.timestamp': event['event.timestamp'],
    status: event.status,
    agents_dispatched: event.agents_dispatched,
    agents_completed: event.agents_completed,
    phase_count: event.phase_count,
    tokens_spent: event.tokens_spent,
    duration_ms: event.duration_ms,
  };
  const logger = logs.getLogger(SERVICE_NAME);
  logger.emit({ body: `Workflow run ${event.status}.`, attributes });
}

// ─── Auto-Memory Log Functions ───────────────────────────────────────────────

export function logMemoryExtract(
  config: Config,
  event: MemoryExtractEvent,
): void {
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_MEMORY_EXTRACT,
    'event.timestamp': event['event.timestamp'],
    trigger: event.trigger,
    status: event.status,
    patches_count: event.patches_count,
    touched_topics: event.touched_topics,
    duration_ms: event.duration_ms,
  };
  if (event.skipped_reason) {
    attributes['skipped_reason'] = event.skipped_reason;
  }

  const logger = logs.getLogger(SERVICE_NAME);
  logger.emit({
    body: `Memory extract: ${event.status}. Patches: ${event.patches_count}. Topics: ${event.touched_topics || 'none'}.`,
    attributes,
  });
  recordMemoryExtractMetrics(config, event.duration_ms, {
    trigger: event.trigger,
    status: event.status,
    patches_count: event.patches_count,
  });
}

export function logMemoryDream(config: Config, event: MemoryDreamEvent): void {
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_MEMORY_DREAM,
    'event.timestamp': event['event.timestamp'],
    trigger: event.trigger,
    status: event.status,
    deduped_entries: event.deduped_entries,
    touched_topics_count: event.touched_topics_count,
    touched_topics: event.touched_topics,
    duration_ms: event.duration_ms,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  logger.emit({
    body: `Memory dream: ${event.status}. Deduped: ${event.deduped_entries}. Topics: ${event.touched_topics || 'none'}.`,
    attributes,
  });
  recordMemoryDreamMetrics(config, event.duration_ms, {
    trigger: event.trigger,
    status: event.status,
    deduped_entries: event.deduped_entries,
  });
}

export function logMemoryRecall(
  config: Config,
  event: MemoryRecallEvent,
): void {
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_MEMORY_RECALL,
    'event.timestamp': event['event.timestamp'],
    query_length: event.query_length,
    docs_scanned: event.docs_scanned,
    docs_selected: event.docs_selected,
    strategy: event.strategy,
    duration_ms: event.duration_ms,
  };

  const logger = logs.getLogger(SERVICE_NAME);
  logger.emit({
    body: `Memory recall: strategy=${event.strategy}. Selected ${event.docs_selected}/${event.docs_scanned} docs.`,
    attributes,
  });
  recordMemoryRecallMetrics(config, event.duration_ms, {
    strategy: event.strategy,
    docs_selected: event.docs_selected,
  });
}

// ─── DLH Telemetry Functions ──────────────────────────────────────────────────

export interface InferenceLogEvent {
  prompt_id: string;
  response_id?: string;
  prompt_text: string;
  prompt_text_length?: number;
  /**
   * Полный сырой ответ модели для DLH-инференса: thoughts, tool calls и текст.
   * Идёт в `inference.model_response`. Обычно — JSON-стрингификация parts.
   */
  model_response: string | null;
  model_response_length?: number | null;
  /**
   * Только видимый пользователю текст ответа (без thoughts/tool calls).
   * Используется как `message.content` для роли `agent` с `type: 'text'`;
   * если пусто после trim — `message` не эмитится.
   */
  user_visible_text?: string | null;
  /**
   * Размышления модели (✦-блоки в TUI), склейка text-парт с `thought: true`.
   * Эмитится отдельным `message` с `type: 'thought'`; если пусто — скип.
   */
  user_visible_thought_text?: string | null;
  client_prompt_sent_at: number;
  client_prompt_finished_at: number | null;
  model_id: string;
  generate_params_json: string;
  status: 'success' | 'error' | 'aborted';
  error_status_code: number | null;
  tokens_input?: number;
  tokens_output?: number;
  tokens_cached?: number;
  reasoning_tokens?: number;
  details_json?: string | null;
  include_content?: boolean;
}

export function logApiInference(
  config: Config,
  event: InferenceLogEvent,
): void {
  const dlhContext = getCurrentDlhContext();
  // [nessy-fork] dlh-telemetry
  const type: InferenceType = isRecallMemoryInference()
    ? 'recall_memory'
    : subagentNameContext.getStore() === 'managed-auto-memory-extractor'
      ? 'extract_memory'
      : 'base';
  // Внутренние side-query (prompt-suggestion, next-speaker,
  // chat-compression и т.п.) делают свои inference поверх пользовательского
  // turn'а. В DLH мы хотим только три типа: base (запрос пользователя),
  // recall_memory (auto-memory recall перед запросом), extract_memory
  // (auto-memory extract после запроса). Остальные base-инференсы с
  // внутренним prompt_id отбрасываем здесь — иначе на один пользовательский
  // запрос в DLH летит куча лишних событий.
  if (type === 'base' && isInternalPromptId(event.prompt_id)) {
    return;
  }
  // recall_memory — это side-query внутри пользовательского turn'а; у него
  // нет собственного `agent_request`, поэтому inference атрибутируем к
  // пользовательскому prompt_id (активный promptId из DLH-контекста).
  // extract_memory наоборот: у subagent'а есть собственный `agent_request`
  // с его prompt_id, а связь с пользовательским запросом идёт через
  // `parent_prompt_id` в `agent_request`. Поэтому здесь оставляем
  // event.prompt_id как есть (= subagentId).
  const promptId =
    type === 'recall_memory' && dlhContext?.promptId
      ? dlhContext.promptId
      : event.prompt_id;
  const nessyDlh = getNessyDlh();
  nessyDlh?.emit('inference', {
    inference_id: event.response_id ?? null,
    prompt_id: promptId,
    type,
    session_id: config.getSessionId(),
    prompt_text: event.prompt_text,
    prompt_text_length: event.prompt_text.length,
    model_response: event.model_response,
    model_response_length: event.model_response?.length ?? null,
    client_prompt_sent_at: event.client_prompt_sent_at,
    client_prompt_finished_at: event.client_prompt_finished_at,
    model_id: event.model_id,
    generate_params_json: event.generate_params_json,
    status: event.status,
    error_status_code: event.error_status_code,
    tokens_input: event.tokens_input ?? null,
    tokens_output: event.tokens_output ?? null,
    tokens_cached: event.tokens_cached ?? null,
    reasoning_tokens: event.reasoning_tokens ?? null,
    details_json: event.details_json ?? null,
    include_content: shouldLogUserPrompts(config),
    sensitive_data_filtered: false,
    config,
  });

  // Store the response_id as the current inference_id in the DLH context for tool calls
  if (dlhContext && event.response_id) {
    dlhContext.inferenceId = event.response_id;
  }

  // Agent message событие — одно на инференс. content — JSON-строка с
  // двумя ключами: `thoughts` (размышления модели, ✦-блоки в TUI) и
  // `text` (финальный ответ). Если в turn'е была только tool_call без
  // текста — оба поля могут быть null. Если оба пусты — message не
  // эмитим. Гейты: только base, только не-subagent.
  const userVisible = event.user_visible_text ?? null;
  const thoughtText = event.user_visible_thought_text ?? null;
  const hasText = userVisible !== null && userVisible.trim().length > 0;
  const hasThought = thoughtText !== null && thoughtText.trim().length > 0;
  if (
    type === 'base' &&
    !subagentNameContext.getStore() &&
    (hasText || hasThought)
  ) {
    const content = JSON.stringify({
      thoughts: hasThought ? thoughtText : null,
      text: hasText ? userVisible : null,
    });
    nessyDlh?.emit('message', {
      session_id: config.getSessionId(),
      prompt_id: event.prompt_id,
      role: 'agent',
      content,
      include_content: shouldLogUserPrompts(config),
      sensitive_data_filtered: false,
      config,
    });
  }
}

export function logMaxTurnsReached(config: Config, promptId: string): void {
  getNessyDlh()?.emit('max_turns_reached', {
    prompt_id: promptId,
    max_turns: config.getMaxSessionTurns(),
    config,
  });
}

export function logTokenLimitExceeded(
  config: Config,
  promptId: string,
  currentTokens: number,
  limit: number,
): void {
  getNessyDlh()?.emit('token_limit_exceeded', {
    prompt_id: promptId,
    current_tokens: currentTokens,
    limit,
    config,
  });
}

// [nessy-fork] dlh-launch-metadata — передаём метаданные запуска в DLH
function buildAgentParamsJson(config: Config): string {
  return JSON.stringify({
    model: config.getModel(),
    approval_mode: config.getApprovalMode(),
    sandbox_enabled:
      typeof config.getSandbox() === 'string' || !!config.getSandbox(),
    debug_enabled: config.getDebugMode(),
    launch_mode: getAgentLaunchMode(config),
    channel: config.getChannel(),
    ext_version: config.getExtensionVersion(),
  });
}

export function logDlhAgentRequest(
  config: Config,
  params: {
    prompt_id: string;
    agent_name: string;
    agent_mode?: string;
    parent_tool_call_id?: string | null;
    parent_prompt_id?: string | null;
    client_created_at: number;
  },
): void {
  const nessyDlh = getNessyDlh();
  if (!nessyDlh) return;

  // [nessy-fork] dlh-telemetry — resolve extension attribution from the subagent
  // name (fork-owned, scans active extensions) rather than threading it through
  // AgentCore, keeping the upstream agent runtime untouched.
  const { extension_name, extension_source } = resolveSubagentExtensionInfo(
    config,
    params.agent_name,
  );

  nessyDlh.emit('agent_request', {
    prompt_id: params.prompt_id,
    agent_mode: params.agent_mode ?? 'subagent',
    agent_name: params.agent_name,
    agent_hash: createHash('sha256').update(params.agent_name).digest('hex'),
    nestor_user_id: 'unknown',
    parent_tool_call_id: getDlhParentToolCallId(params.parent_tool_call_id),
    parent_prompt_id: getDlhParentPromptId(params.parent_prompt_id),
    version: process.version,
    host: hostname(),
    pwd: process.cwd(),
    os: process.platform,
    agent_params_json: buildAgentParamsJson(config),
    client_created_at: params.client_created_at,
    extension_name,
    extension_source,
    config,
  });
}

function extractDlhToolResponse(parts: Part[] | undefined): string | null {
  if (!parts || parts.length === 0) return null;

  const fragments: string[] = [];
  for (const part of parts) {
    if (part.functionResponse?.response) {
      const response = part.functionResponse.response as Record<
        string,
        unknown
      >;
      const output = response['output'] ?? response['content'] ?? response;
      fragments.push(
        typeof output === 'string' ? output : JSON.stringify(output),
      );
    } else if ('text' in part && typeof part.text === 'string' && part.text) {
      fragments.push(part.text);
    }
  }

  if (fragments.length === 0) return null;
  return fragments.join('\n');
}

export interface DlhToolCallApprovalTimings {
  /** Когда tool перешёл в `awaiting_approval` (UI показал диалог). */
  sentAt?: number | null;
  /** Когда tool вышел из `awaiting_approval` (пользователь решил). */
  receivedAt?: number | null;
}

export function logDlhToolCall(
  config: Config,
  toolCall: CompletedToolCall,
  approvalTimings?: DlhToolCallApprovalTimings,
): void {
  const nessyDlh = getNessyDlh();
  if (!nessyDlh) return;

  // Skip if tool is not available (can happen in error cases)
  if (!toolCall.tool) return;

  const outcome = toolCall.outcome;
  const decision = outcome ? getDecisionFromOutcome(outcome) : null;

  const tool = toolCall.tool;
  const isMcpTool = tool instanceof DiscoveredMCPTool;
  const mcpServerName =
    isMcpTool && 'serverName' in tool
      ? (tool as DiscoveredMCPTool).serverName
      : null;

  const callJson = JSON.stringify(toolCall.request.args ?? {});

  const responseContent = extractDlhToolResponse(
    toolCall.response.responseParts,
  );

  // [nessy-fork] dlh-telemetry — extension attribution within tool_call has
  // three sources, all keyed by what the call dispatches rather than the tool
  // name itself (resolution is fork-owned, scanning active extensions):
  //  - MCP tools: the server is provided by an extension (`mcp_server_name`);
  //  - the native `Skill` tool: dispatches a skill named in `args.skill`;
  //  - the native `Agent` tool: dispatches a subagent named in
  //    `args.subagent_type` (a fork — no subagent_type — resolves to null).
  const args = toolCall.request.args;
  const { extension_name, extension_source } = ((): {
    extension_name: string | null;
    extension_source: string | null;
  } => {
    if (tool.name === ToolNames.SKILL) {
      const skillName =
        typeof args?.['skill'] === 'string' ? args['skill'] : null;
      return resolveSkillExtensionInfo(config, skillName);
    }
    if (tool.name === ToolNames.AGENT) {
      const subagentName =
        typeof args?.['subagent_type'] === 'string'
          ? args['subagent_type']
          : null;
      return resolveSubagentExtensionInfo(config, subagentName);
    }
    return resolveMcpExtensionInfo(config, mcpServerName);
  })();

  nessyDlh.emit('tool_call', {
    tool_call_id: toolCall.request.callId,
    prompt_id: toolCall.request.prompt_id,
    inference_id: toolCall.request.response_id ?? null,
    function_name: tool.name,
    client_created_at: Date.now(),
    client_finished_at: Date.now(),
    client_approve_sent_at: approvalTimings?.sentAt ?? null,
    client_approve_received_at: approvalTimings?.receivedAt ?? null,
    call_json: callJson,
    call_json_length: callJson.length,
    response: responseContent,
    response_length: responseContent?.length ?? null,
    status: toolCall.status === 'success' ? 'success' : 'error',
    decision: decision as 'approve' | 'reject' | 'auto' | null,
    tool_type: isMcpTool ? 'mcp' : 'native',
    mcp_server_name: mcpServerName,
    extension_name,
    extension_source,
    include_content: shouldLogUserPrompts(config),
    sensitive_data_filtered: false,
    config,
  });
}

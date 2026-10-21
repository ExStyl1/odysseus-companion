/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { CompletedToolCall, AnyToolInvocation } from '../index.js';
import type { CallableTool } from '@google/genai';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import {
  AuthType,
  ToolConfirmationOutcome,
  DiscoveredMCPTool,
  ToolErrorType,
} from '../index.js';
import { ReadFileTool } from '../tools/read-file.js';
import {
  logDlhToolCall,
  logDlhAgentRequest,
  logApiInference,
  type InferenceLogEvent,
} from './loggers.js';
import {
  createDlhContext,
  runInDlhContext,
  getCurrentDlhContext,
} from './nessy-dlh/dlh-context.js';
import { runInRecallMemoryInference } from './nessy-dlh/inference-type-context.js';
import { subagentNameContext } from '../utils/subagentNameContext.js';
import { resetNessyDlh, initNessyDlh } from './nessy-dlh/index.js';

// Mock NessyDlh
const mockNessyDlhEmit = vi.fn();

vi.mock('./nessy-dlh/nessy-dlh.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./nessy-dlh/nessy-dlh.js')>();
  return {
    ...actual,
    NessyDlh: class MockNessyDlh {
      emit = mockNessyDlhEmit;
      initializeSession = vi.fn();
      recordSessionStart = vi.fn();
    },
  };
});

describe('DLH logging functions', () => {
  let mockConfig: Config;

  beforeEach(() => {
    mockNessyDlhEmit.mockClear();
    resetNessyDlh();

    mockConfig = {
      getSessionId: () => 'test-session-id',
      getAuthType: () => AuthType.USE_GEMINI,
      getNessyDlhEnabled: () => true,
      getUsageStatisticsEnabled: () => true,
      getProjectRoot: () => '/test/project',
      getTelemetryLogPromptsEnabled: () => true,
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getSandbox: () => false,
      getDebugMode: () => false,
      getMcpServers: () => ({}),
      getExtensions: () => [],
      getActiveExtensions: () => [],
      getChannel: () => undefined,
      getExtensionVersion: () => undefined,
      isInteractive: () => false,
    } as unknown as Config;

    // Initialize DLH instance
    initNessyDlh(mockConfig);
  });

  afterEach(() => {
    resetNessyDlh();
    vi.clearAllMocks();
  });

  describe('logDlhToolCall', () => {
    it('should send tool call to DLH with inference_id from response_id', () => {
      const mockCompletedToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'read_file',
          args: { path: 'test.txt' },
          callId: 'call-123',
          isClientInitiated: true,
          prompt_id: 'prompt-1',
          response_id: 'inference-abc',
        },
        response: {
          callId: 'call-123',
          responseParts: [{ text: 'file content' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: new ReadFileTool(mockConfig),
        invocation: {} as AnyToolInvocation,
        durationMs: 100,
        outcome: ToolConfirmationOutcome.ProceedOnce,
      };

      logDlhToolCall(mockConfig, mockCompletedToolCall);

      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'tool_call',
        expect.objectContaining({
          tool_call_id: 'call-123',
          prompt_id: 'prompt-1',
          inference_id: 'inference-abc',
          function_name: 'read_file',
          status: 'success',
          decision: 'accept',
          tool_type: 'native',
          include_content: true,
        }),
      );
    });

    it('should handle MCP tools correctly', () => {
      const mockMcpTool = new DiscoveredMCPTool(
        {} as CallableTool,
        'test-mcp-server',
        'mcp_tool',
        'tool desc',
        { type: 'object', properties: {}, required: [] },
      );

      const mockCompletedToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'mcp_tool',
          args: {},
          callId: 'call-456',
          isClientInitiated: true,
          prompt_id: 'prompt-2',
          response_id: 'inference-xyz',
        },
        response: {
          callId: 'call-456',
          responseParts: [{ text: 'mcp result' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: mockMcpTool,
        invocation: {} as AnyToolInvocation,
        durationMs: 50,
      };

      logDlhToolCall(mockConfig, mockCompletedToolCall);

      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'tool_call',
        expect.objectContaining({
          tool_type: 'mcp',
          mcp_server_name: 'test-mcp-server',
        }),
      );
    });

    it('should attribute extension for a skill invoked via the Skill tool', () => {
      // The native `Skill` tool dispatches a skill named in its args; an
      // extension-provided skill must surface extension_name/extension_source.
      mockConfig.getActiveExtensions = () =>
        [
          {
            name: 'ext-pdf',
            installMetadata: { source: 'git:pdf-ext', type: 'git' },
            skills: [{ name: 'pdf' }],
          },
        ] as unknown as ReturnType<Config['getActiveExtensions']>;

      const skillToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'skill',
          args: { skill: 'pdf' },
          callId: 'call-skill',
          isClientInitiated: true,
          prompt_id: 'prompt-skill',
          response_id: 'inf-skill',
        },
        response: {
          callId: 'call-skill',
          responseParts: [{ text: 'skill result' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: { name: 'skill' } as unknown as AnyDeclarativeTool,
        invocation: {} as AnyToolInvocation,
        durationMs: 10,
      };

      logDlhToolCall(mockConfig, skillToolCall);

      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'tool_call',
        expect.objectContaining({
          tool_type: 'native',
          mcp_server_name: null,
          extension_name: 'ext-pdf',
          extension_source: 'git:pdf-ext',
        }),
      );
    });

    it('should attribute extension for a subagent invoked via the Agent tool', () => {
      // The native `Agent` tool dispatches a subagent named in subagent_type;
      // an extension-provided subagent must surface extension attribution.
      mockConfig.getActiveExtensions = () =>
        [
          {
            name: 'ext-review',
            installMetadata: { source: 'npm:review-ext', type: 'npm' },
            agents: [{ name: 'reviewer' }],
          },
        ] as unknown as ReturnType<Config['getActiveExtensions']>;

      const agentToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'agent',
          args: { subagent_type: 'reviewer' },
          callId: 'call-agent',
          isClientInitiated: true,
          prompt_id: 'prompt-agent',
          response_id: 'inf-agent',
        },
        response: {
          callId: 'call-agent',
          responseParts: [{ text: 'agent result' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: { name: 'agent' } as unknown as AnyDeclarativeTool,
        invocation: {} as AnyToolInvocation,
        durationMs: 10,
      };

      logDlhToolCall(mockConfig, agentToolCall);

      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'tool_call',
        expect.objectContaining({
          tool_type: 'native',
          mcp_server_name: null,
          extension_name: 'ext-review',
          extension_source: 'npm:review-ext',
        }),
      );
    });

    it('should pass through approval timings (sent/received) into tool_call', () => {
      const mockCompletedToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'read_file',
          args: { path: 'a' },
          callId: 'call-approve',
          isClientInitiated: true,
          prompt_id: 'p1',
          response_id: 'inf-1',
        },
        response: {
          callId: 'call-approve',
          responseParts: [{ text: 'ok' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: new ReadFileTool(mockConfig),
        invocation: {} as AnyToolInvocation,
        durationMs: 10,
        outcome: ToolConfirmationOutcome.ProceedOnce,
      };

      logDlhToolCall(mockConfig, mockCompletedToolCall, {
        sentAt: 1_000_000,
        receivedAt: 1_000_500,
      });

      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'tool_call',
        expect.objectContaining({
          client_approve_sent_at: 1_000_000,
          client_approve_received_at: 1_000_500,
        }),
      );
    });

    it('should default approval timings to null when not provided', () => {
      const mockCompletedToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'read_file',
          args: {},
          callId: 'call-no-approve',
          isClientInitiated: true,
          prompt_id: 'p1',
          response_id: 'inf-1',
        },
        response: {
          callId: 'call-no-approve',
          responseParts: [],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: new ReadFileTool(mockConfig),
        invocation: {} as AnyToolInvocation,
        durationMs: 1,
      };

      logDlhToolCall(mockConfig, mockCompletedToolCall);

      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'tool_call',
        expect.objectContaining({
          client_approve_sent_at: null,
          client_approve_received_at: null,
        }),
      );
    });

    it('should handle null response_id gracefully', () => {
      const mockCompletedToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'read_file',
          args: {},
          callId: 'call-789',
          isClientInitiated: true,
          prompt_id: 'prompt-3',
          // response_id is undefined
        },
        response: {
          callId: 'call-789',
          responseParts: [],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: new ReadFileTool(mockConfig),
        invocation: {} as AnyToolInvocation,
        durationMs: 50,
      };

      logDlhToolCall(mockConfig, mockCompletedToolCall);

      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'tool_call',
        expect.objectContaining({
          inference_id: null,
        }),
      );
    });

    it('should skip if NessyDlh is not available', () => {
      resetNessyDlh(); // Clear the instance

      const mockCompletedToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'read_file',
          args: {},
          callId: 'call-999',
          isClientInitiated: true,
          prompt_id: 'prompt-4',
          response_id: 'inference-999',
        },
        response: {
          callId: 'call-999',
          responseParts: [],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: new ReadFileTool(mockConfig),
        invocation: {} as AnyToolInvocation,
        durationMs: 50,
      };

      logDlhToolCall(mockConfig, mockCompletedToolCall);

      expect(mockNessyDlhEmit).not.toHaveBeenCalled();
    });

    it('should skip if tool is not available', () => {
      const mockCompletedToolCall: CompletedToolCall = {
        status: 'error',
        request: {
          name: 'unknown_tool',
          args: {},
          callId: 'call-888',
          isClientInitiated: true,
          prompt_id: 'prompt-5',
          response_id: 'inference-888',
        },
        response: {
          callId: 'call-888',
          responseParts: [],
          resultDisplay: undefined,
          error: new Error('Tool not found'),
          errorType: ToolErrorType.TOOL_NOT_REGISTERED,
        },
        tool: undefined as AnyDeclarativeTool | undefined, // Tool not available
        durationMs: 50,
      };

      logDlhToolCall(mockConfig, mockCompletedToolCall);

      expect(mockNessyDlhEmit).not.toHaveBeenCalled();
    });
  });

  describe('logDlhAgentRequest', () => {
    it('should send agent request to DLH', () => {
      const params = {
        prompt_id: 'prompt-agent-1',
        agent_name: 'managed-auto-memory-extractor',
        parent_tool_call_id: 'tool-123',
        parent_prompt_id: 'prompt-parent',
        client_created_at: Date.now(),
      };

      logDlhAgentRequest(mockConfig, params);

      expect(mockNessyDlhEmit).toHaveBeenCalledWith('agent_request', {
        prompt_id: 'prompt-agent-1',
        agent_mode: 'subagent',
        agent_name: 'managed-auto-memory-extractor',
        agent_hash: expect.any(String),
        nestor_user_id: 'unknown',
        parent_tool_call_id: 'tool-123',
        parent_prompt_id: 'prompt-parent',
        version: expect.any(String),
        host: expect.any(String),
        pwd: expect.any(String),
        os: expect.any(String),
        agent_params_json: JSON.stringify({
          model: 'test-model',
          approval_mode: 'default',
          sandbox_enabled: false,
          debug_enabled: false,
          launch_mode: 'nonInteractive',
          channel: undefined,
          ext_version: undefined,
        }),
        client_created_at: expect.any(Number),
        extension_name: null,
        extension_source: null,
        config: mockConfig,
      });
    });
  });

  describe('logApiInference', () => {
    it('should send inference event to DLH with response_id', () => {
      const mockInferenceEvent: InferenceLogEvent = {
        prompt_id: 'prompt-inf-1',
        response_id: 'inference-123',
        prompt_text: 'test prompt',
        model_response: 'test response',
        model_id: 'test-model',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        tokens_input: 10,
        tokens_output: 5,
        tokens_cached: 0,
        reasoning_tokens: 0,
        details_json: '{}',
        include_content: true,
      };

      logApiInference(mockConfig, mockInferenceEvent);

      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'inference',
        expect.objectContaining({
          prompt_id: 'prompt-inf-1',
          inference_id: 'inference-123',
          type: 'base',
          status: 'success',
          sensitive_data_filtered: false,
        }),
      );
    });

    it('should set inferenceId in DLH context', () => {
      const mockInferenceEvent: InferenceLogEvent = {
        prompt_id: 'prompt-inf-2',
        response_id: 'inference-456',
        prompt_text: 'test',
        model_response: 'response',
        model_id: 'test-model',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        tokens_input: 10,
        tokens_output: 5,
        tokens_cached: 0,
        reasoning_tokens: 0,
        details_json: '{}',
        include_content: true,
      };

      // Initialize DLH context
      const context = createDlhContext(
        'test-session',
        0,
        AuthType.USE_GEMINI,
        mockConfig,
      );
      context.promptId = 'prompt-inf-2';

      runInDlhContext(context, () => {
        logApiInference(mockConfig, mockInferenceEvent);

        const currentContext = getCurrentDlhContext();
        expect(currentContext?.inferenceId).toBe('inference-456');
      });

      // A normal turn runs inside a DLH context whose promptId is set; that
      // alone must NOT label the inference as recall_memory.
      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'inference',
        expect.objectContaining({ type: 'base' }),
      );
    });

    it('should tag inference as recall_memory inside recall context', () => {
      const mockInferenceEvent: InferenceLogEvent = {
        prompt_id: 'side-query:auto-memory-recall',
        response_id: 'inference-recall',
        prompt_text: 'recall prompt',
        model_response: 'recall response',
        model_id: 'test-model',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        include_content: true,
      };

      const context = createDlhContext(
        'test-session',
        0,
        AuthType.USE_GEMINI,
        mockConfig,
      );
      context.promptId = 'parent-prompt';

      runInDlhContext(context, () => {
        runInRecallMemoryInference(() => {
          logApiInference(mockConfig, mockInferenceEvent);
        });
      });

      // type is recall_memory, and prompt_id is rewritten from the
      // side-query id to the user's request prompt_id (the DLH-context promptId).
      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'inference',
        expect.objectContaining({
          type: 'recall_memory',
          prompt_id: 'parent-prompt',
        }),
      );
    });

    it('should tag inference as extract_memory and keep subagent prompt_id', () => {
      const mockInferenceEvent: InferenceLogEvent = {
        prompt_id: 'managed-auto-memory-extractor-subagent',
        response_id: 'inference-extract',
        prompt_text: 'extract prompt',
        model_response: 'extract response',
        model_id: 'test-model',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        include_content: true,
      };

      const context = createDlhContext(
        'test-session',
        0,
        AuthType.USE_GEMINI,
        mockConfig,
      );
      context.promptId = 'user-request-prompt';

      runInDlhContext(context, () => {
        subagentNameContext.run('managed-auto-memory-extractor', () => {
          logApiInference(mockConfig, mockInferenceEvent);
        });
      });

      // extract_memory subagent имеет собственный agent_request с этим
      // prompt_id; связь с пользовательским запросом идёт через
      // parent_prompt_id в agent_request, а не через rewrite здесь.
      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'inference',
        expect.objectContaining({
          type: 'extract_memory',
          prompt_id: 'managed-auto-memory-extractor-subagent',
        }),
      );
    });

    it('should emit a single agent message with JSON content {thoughts,text} for base inference', () => {
      const baseEvent: InferenceLogEvent = {
        prompt_id: 'user-prompt-id',
        response_id: 'inference-base',
        prompt_text: 'hi',
        model_response:
          '[{"text":"reasoning...","thought":true},{"text":"hello back"}]',
        user_visible_text: 'hello back',
        user_visible_thought_text: 'reasoning...',
        model_id: 'm',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        include_content: true,
      };

      logApiInference(mockConfig, baseEvent);

      const messageCalls = mockNessyDlhEmit.mock.calls.filter(
        (c) => c[0] === 'message',
      );
      expect(messageCalls).toHaveLength(1);
      const payload = messageCalls[0][1] as { content: string; role: string };
      expect(payload.role).toBe('agent');
      expect(JSON.parse(payload.content)).toEqual({
        thoughts: 'reasoning...',
        text: 'hello back',
      });
    });

    it('should include null for missing thoughts/text in JSON content', () => {
      const textOnlyEvent: InferenceLogEvent = {
        prompt_id: 'p1',
        response_id: 'inf1',
        prompt_text: 'hi',
        model_response: '[{"text":"hello"}]',
        user_visible_text: 'hello',
        user_visible_thought_text: null,
        model_id: 'm',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        include_content: true,
      };
      logApiInference(mockConfig, textOnlyEvent);

      const msg1 = mockNessyDlhEmit.mock.calls.find(
        (c) => c[0] === 'message',
      )?.[1] as { content: string };
      expect(JSON.parse(msg1.content)).toEqual({
        thoughts: null,
        text: 'hello',
      });

      mockNessyDlhEmit.mockClear();

      const thoughtOnlyEvent: InferenceLogEvent = {
        ...textOnlyEvent,
        user_visible_text: '\n\n',
        user_visible_thought_text: 'thinking',
      };
      logApiInference(mockConfig, thoughtOnlyEvent);

      const msg2 = mockNessyDlhEmit.mock.calls.find(
        (c) => c[0] === 'message',
      )?.[1] as { content: string };
      expect(JSON.parse(msg2.content)).toEqual({
        thoughts: 'thinking',
        text: null,
      });
    });

    it('should NOT emit agent message when user_visible_text is empty/whitespace (thoughts + tool call only)', () => {
      const baseEvent: InferenceLogEvent = {
        prompt_id: 'user-prompt-id',
        response_id: 'inference-thoughts-only',
        prompt_text: 'list files',
        // Модель только thought-ала и сделала tool_call — текст пустой.
        model_response:
          '[{"thought":true,"text":"reasoning..."},{"functionCall":{"name":"list_directory"}},{"text":"\\n\\n"}]',
        user_visible_text: '\n\n',
        model_id: 'm',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        include_content: true,
      };

      logApiInference(mockConfig, baseEvent);

      const eventTypes = mockNessyDlhEmit.mock.calls.map((c) => c[0]);
      expect(eventTypes).toContain('inference');
      expect(eventTypes).not.toContain('message');
    });

    it('should NOT emit agent message for extract_memory subagent inference', () => {
      const extractEvent: InferenceLogEvent = {
        prompt_id: 'managed-auto-memory-extractor-subagent',
        response_id: 'inference-extract',
        prompt_text: 'extract prompt',
        model_response: 'extractor analysis text',
        model_id: 'm',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        include_content: true,
      };

      const context = createDlhContext(
        'test-session',
        0,
        AuthType.USE_GEMINI,
        mockConfig,
      );
      context.promptId = 'user-request-prompt';

      runInDlhContext(context, () => {
        subagentNameContext.run('managed-auto-memory-extractor', () => {
          logApiInference(mockConfig, extractEvent);
        });
      });

      const eventTypes = mockNessyDlhEmit.mock.calls.map((c) => c[0]);
      expect(eventTypes).toContain('inference');
      expect(eventTypes).not.toContain('message');
    });

    it('should NOT emit agent message for recall_memory inference', () => {
      const recallEvent: InferenceLogEvent = {
        prompt_id: 'side-query:auto-memory-recall',
        response_id: 'inference-recall',
        prompt_text: 'recall prompt',
        model_response: '{"selected_memories":[]}',
        model_id: 'm',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        include_content: true,
      };

      const context = createDlhContext(
        'test-session',
        0,
        AuthType.USE_GEMINI,
        mockConfig,
      );
      context.promptId = 'user-request-prompt';

      runInDlhContext(context, () => {
        runInRecallMemoryInference(() => {
          logApiInference(mockConfig, recallEvent);
        });
      });

      const eventTypes = mockNessyDlhEmit.mock.calls.map((c) => c[0]);
      expect(eventTypes).toContain('inference');
      expect(eventTypes).not.toContain('message');
    });

    it('should skip base inferences with internal prompt_id', () => {
      const internalPromptIds = [
        'prompt_suggestion',
        'forked_query',
        'speculation',
        'side-query:auto-memory-recall',
        'side-query:next-speaker',
        'side-query:chat-compression',
      ];

      for (const promptId of internalPromptIds) {
        const mockInferenceEvent: InferenceLogEvent = {
          prompt_id: promptId,
          response_id: 'inference-internal',
          prompt_text: 'internal prompt',
          model_response: 'internal response',
          model_id: 'test-model',
          generate_params_json: '{}',
          status: 'success',
          error_status_code: null,
          client_prompt_sent_at: Date.now(),
          client_prompt_finished_at: Date.now(),
          include_content: true,
        };
        logApiInference(mockConfig, mockInferenceEvent);
      }

      expect(mockNessyDlhEmit).not.toHaveBeenCalled();
    });

    it('should handle inference without response_id', () => {
      const mockInferenceEvent: InferenceLogEvent = {
        prompt_id: 'prompt-inf-3',
        // response_id is undefined
        prompt_text: 'test',
        model_response: 'response',
        model_id: 'test-model',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        tokens_input: 10,
        tokens_output: 5,
        tokens_cached: 0,
        reasoning_tokens: 0,
        details_json: '{}',
        include_content: true,
      };

      logApiInference(mockConfig, mockInferenceEvent);

      // Check that inference event was sent (inference_id will be null)
      const firstCall = mockNessyDlhEmit.mock.calls[0];
      expect(firstCall[0]).toBe('inference');
      expect((firstCall[1] as Record<string, unknown>)['prompt_id']).toBe(
        'prompt-inf-3',
      );
      expect(
        (firstCall[1] as Record<string, unknown>)['inference_id'],
      ).toBeNull();
    });
  });
});

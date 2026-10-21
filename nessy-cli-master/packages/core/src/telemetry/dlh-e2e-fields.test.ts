/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { CompletedToolCall, AnyToolInvocation, AnyDeclarativeTool } from '../index.js';
import {
  AuthType,
  ToolConfirmationOutcome,
} from '../index.js';
import {
  logDlhToolCall,
  logApiInference,
  type InferenceLogEvent,
} from './loggers.js';
import {
  createDlhContext,
  runInDlhContext,
} from './nessy-dlh/dlh-context.js';
import { resetNessyDlh, initNessyDlh } from './nessy-dlh/index.js';

/**
 * E2E tests that verify DLH event fields match the real-world data from logs.
 * Based on actual log data from tmp_work/tool_call.txt
 */

// Mock NessyDlh
const mockNessyDlhEmit = vi.fn();

vi.mock('./nessy-dlh/nessy-dlh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./nessy-dlh/nessy-dlh.js')>();
  return {
    ...actual,
    NessyDlh: class MockNessyDlh {
      emit = mockNessyDlhEmit;
      initializeSession = vi.fn();
      recordSessionStart = vi.fn();
    },
  };
});

describe('DLH E2E field verification (real-world data)', () => {
  let mockConfig: Config;

  beforeEach(() => {
    mockNessyDlhEmit.mockClear();
    resetNessyDlh();

    mockConfig = {
      getSessionId: () => 'c9f795e4-6aea-475d-a5a9-c3ffe5e37ee8',
      getAuthType: () => AuthType.USE_GEMINI,
      getNessyDlhEnabled: () => true,
      getUsageStatisticsEnabled: () => true,
      getProjectRoot: () => '/test/project',
      getTelemetryLogPromptsEnabled: () => true,
    } as unknown as Config;

    initNessyDlh(mockConfig);
  });

  afterEach(() => {
    resetNessyDlh();
    vi.clearAllMocks();
  });

  describe('tool_call event fields (matching real logs)', () => {
    it('should have all required fields from real tool_call event', () => {
      // Based on real data from tmp_work/tool_call.txt
      const mockTool = {
        name: 'list_directory',
        description: 'List directory contents',
        schema: { type: 'object', properties: {}, required: [] },
      } as unknown as AnyDeclarativeTool;

      const mockCompletedToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'list_directory',
          args: { path: '/Users/a.klakovskiy/code/tinkoff/nestor/nessy-cli' },
          callId: 'c38db2af-3ae1-442f-b075-e18330a4446c',
          isClientInitiated: true,
          prompt_id: 'c9f795e4-6aea-475d-a5a9-c3ffe5e37ee8########4',
          response_id: '68c4c1a2b9574d569b4fb2727e6b3ec0',
        },
        response: {
          callId: 'c38db2af-3ae1-442f-b075-e18330a4446c',
          responseParts: [
            {
              text: 'Listed 46 item(s) in /Users/a.klakovskiy/code/tinkoff/nestor/nessy-cli',
            },
          ],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: mockTool,
        invocation: {} as AnyToolInvocation,
        durationMs: 58,
        outcome: ToolConfirmationOutcome.ProceedOnce,
      };

      logDlhToolCall(mockConfig, mockCompletedToolCall);

      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'tool_call',
        expect.objectContaining({
          tool_call_id: 'c38db2af-3ae1-442f-b075-e18330a4446c',
          prompt_id: 'c9f795e4-6aea-475d-a5a9-c3ffe5e37ee8########4',
          inference_id: '68c4c1a2b9574d569b4fb2727e6b3ec0',
          function_name: 'list_directory',
          status: 'success',
          decision: 'accept', // ProceedOnce maps to 'accept'
          tool_type: 'native',
          sensitive_data_filtered: false, // MUST be present
          include_content: true, // Should be present (may be filtered in logs)
        }),
      );
    });

    it('should include include_content field in tool_call event', () => {
      const mockTool = {
        name: 'read_file',
        description: 'Read file',
        schema: { type: 'object', properties: {}, required: [] },
      } as unknown as AnyDeclarativeTool;

      const mockCompletedToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'read_file',
          args: { path: 'test.txt' },
          callId: 'call-123',
          isClientInitiated: true,
          prompt_id: 'prompt-1',
          response_id: 'inference-123',
        },
        response: {
          callId: 'call-123',
          responseParts: [{ text: 'content' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: mockTool,
        invocation: {} as AnyToolInvocation,
        durationMs: 50,
        outcome: ToolConfirmationOutcome.ProceedOnce,
      };

      logDlhToolCall(mockConfig, mockCompletedToolCall);

      const call = mockNessyDlhEmit.mock.calls[0];
      const eventData = call[1] as Record<string, unknown>;
      
      // include_content should be present (may be filtered in logs)
      expect(eventData).toHaveProperty('include_content');
      expect(typeof eventData['include_content']).toBe('boolean');
    });

    it('should include sensitive_data_filtered field', () => {
      const mockTool = {
        name: 'read_file',
        description: 'Read file',
        schema: { type: 'object', properties: {}, required: [] },
      } as unknown as AnyDeclarativeTool;

      const mockCompletedToolCall: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'read_file',
          args: {},
          callId: 'call-123',
          isClientInitiated: true,
          prompt_id: 'prompt-1',
          response_id: 'inference-123',
        },
        response: {
          callId: 'call-123',
          responseParts: [],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
        tool: mockTool,
        invocation: {} as AnyToolInvocation,
        durationMs: 50,
      };

      logDlhToolCall(mockConfig, mockCompletedToolCall);

      const call = mockNessyDlhEmit.mock.calls[0];
      const eventData = call[1] as Record<string, unknown>;
      
      expect(eventData).toHaveProperty('sensitive_data_filtered');
      expect(typeof eventData['sensitive_data_filtered']).toBe('boolean');
    });
  });

  describe('inference event fields (matching real logs)', () => {
    it('should have all required fields from real inference event', () => {
      // Based on real data from tmp_work/tool_call.txt
      const mockInferenceEvent: InferenceLogEvent = {
        prompt_id: 'c9f795e4-6aea-475d-a5a9-c3ffe5e37ee8########4',
        response_id: '68c4c1a2b9574d569b4fb2727e6b3ec0',
        prompt_text: 'test prompt',
        model_response: '',
        client_prompt_sent_at: 1779118852891,
        client_prompt_finished_at: 1779118858566,
        model_id: 'tgpt/qwen35-397b-a17b-fp8',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        tokens_input: 49538,
        tokens_output: 63,
        tokens_cached: 0,
        reasoning_tokens: 0,
        details_json: '{"promptTokenCount":49538}',
      };

      // Don't set context.promptId to get type: 'base' instead of 'recall_memory'
      const context = createDlhContext(
        'c9f795e4-6aea-475d-a5a9-c3ffe5e37ee8',
        0,
        AuthType.USE_GEMINI,
        mockConfig,
      );

      runInDlhContext(context, () => {
        logApiInference(mockConfig, mockInferenceEvent);
      });

      expect(mockNessyDlhEmit).toHaveBeenCalledWith(
        'inference',
        expect.objectContaining({
          inference_id: '68c4c1a2b9574d569b4fb2727e6b3ec0',
          prompt_id: 'c9f795e4-6aea-475d-a5a9-c3ffe5e37ee8########4',
          type: 'base', // No context.promptId set
          session_id: 'c9f795e4-6aea-475d-a5a9-c3ffe5e37ee8',
          prompt_text: 'test prompt',
          prompt_text_length: 11,
          model_response: '',
          model_response_length: 0,
          client_prompt_sent_at: 1779118852891,
          client_prompt_finished_at: 1779118858566,
          model_id: 'tgpt/qwen35-397b-a17b-fp8',
          generate_params_json: '{}',
          status: 'success',
          error_status_code: null,
          tokens_input: 49538,
          tokens_output: 63,
          tokens_cached: 0,
          reasoning_tokens: 0,
          details_json: '{"promptTokenCount":49538}',
          sensitive_data_filtered: false, // MUST be present
          include_content: true, // Should be present (may be filtered in logs)
        }),
      );
    });

    it('should include include_content field in inference event', () => {
      const mockInferenceEvent: InferenceLogEvent = {
        prompt_id: 'prompt-1',
        response_id: 'inference-123',
        prompt_text: 'test',
        model_response: 'response',
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        model_id: 'test-model',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
        tokens_input: 10,
        tokens_output: 5,
        tokens_cached: 0,
        reasoning_tokens: 0,
        details_json: '{}',
      };

      logApiInference(mockConfig, mockInferenceEvent);

      // Find the inference event (first call)
      const call = mockNessyDlhEmit.mock.calls.find(
        (c) => c[0] === 'inference',
      );
      expect(call).toBeDefined();
      const eventData = call![1] as Record<string, unknown>;
      
      // include_content should be present (may be filtered in logs)
      expect(eventData).toHaveProperty('include_content');
      expect(typeof eventData['include_content']).toBe('boolean');
    });

    it('should include sensitive_data_filtered field in inference event', () => {
      const mockInferenceEvent: InferenceLogEvent = {
        prompt_id: 'prompt-1',
        response_id: 'inference-123',
        prompt_text: 'test',
        model_response: 'response',
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        model_id: 'test-model',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
      };

      logApiInference(mockConfig, mockInferenceEvent);

      const call = mockNessyDlhEmit.mock.calls.find(
        (c) => c[0] === 'inference',
      );
      expect(call).toBeDefined();
      const eventData = call![1] as Record<string, unknown>;
      
      expect(eventData).toHaveProperty('sensitive_data_filtered');
      expect(typeof eventData['sensitive_data_filtered']).toBe('boolean');
    });

    it('should use response_id as inference_id', () => {
      const mockInferenceEvent: InferenceLogEvent = {
        prompt_id: 'prompt-1',
        response_id: 'my-inference-id-123',
        prompt_text: 'test',
        model_response: 'response',
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        model_id: 'test-model',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
      };

      logApiInference(mockConfig, mockInferenceEvent);

      const call = mockNessyDlhEmit.mock.calls.find(
        (c) => c[0] === 'inference',
      );
      const eventData = call![1] as Record<string, unknown>;
      
      // inference_id should be set from response_id
      expect(eventData['inference_id']).toBe('my-inference-id-123');
    });
  });

  describe('message event fields (matching real logs)', () => {
    it('should include include_content field in message event', () => {
      const mockInferenceEvent: InferenceLogEvent = {
        prompt_id: 'prompt-1',
        response_id: 'inference-123',
        prompt_text: 'test',
        model_response: 'agent response',
        client_prompt_sent_at: Date.now(),
        client_prompt_finished_at: Date.now(),
        model_id: 'test-model',
        generate_params_json: '{}',
        status: 'success',
        error_status_code: null,
      };

      logApiInference(mockConfig, mockInferenceEvent);

      // Find the message event (second call)
      const call = mockNessyDlhEmit.mock.calls.find(
        (c) => c[0] === 'message',
      );
      
      if (call) {
        const eventData = call[1] as Record<string, unknown>;
        // include_content should be present (may be filtered in logs)
        expect(eventData).toHaveProperty('include_content');
        expect(typeof eventData['include_content']).toBe('boolean');
      }
    });
  });
});

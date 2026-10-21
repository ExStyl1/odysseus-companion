/**
 * @license
 * Copyright 2026 Nessy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { ApprovalMode, Config } from '../config/config.js';
import type { ToolCallRequestInfo } from './turn.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
  redirectDeferredFunctionCall,
  redirectDeferredToolCallRequest,
} from './deferredToolCallRedirect.js';

function makeRegistry(options?: {
  includeToolSearch?: boolean;
  revealDeferredTool?: boolean;
}): ToolRegistry {
  const config = new Config({
    cwd: '/tmp',
    model: 'test-model',
    embeddingModel: 'test-embedding-model',
    sandbox: undefined,
    targetDir: '/tmp',
    debugMode: false,
    userMemory: '',
    geminiMdFileCount: 0,
    approvalMode: ApprovalMode.DEFAULT,
  });
  const registry = new ToolRegistry(config);
  registry.registerTool(
    new MockTool({
      name: 'mcp__time__get_unread_channels',
      shouldDefer: true,
    }),
  );
  registry.registerTool(new MockTool({ name: 'read_file' }));

  if (options?.includeToolSearch ?? true) {
    registry.registerTool(new MockTool({ name: ToolNames.TOOL_SEARCH }));
  }

  if (options?.revealDeferredTool) {
    registry.revealDeferredTool('mcp__time__get_unread_channels');
  }

  return registry;
}

function makeRequest(name: string): ToolCallRequestInfo {
  return {
    callId: 'call-1',
    providerCallId: 'provider-1',
    name,
    args: { original: true },
    isClientInitiated: false,
    prompt_id: 'prompt-1',
  };
}

describe('redirectDeferredToolCallRequest', () => {
  it('redirects unrevealed deferred tool requests to tool_search', () => {
    const request = makeRequest('mcp__time__get_unread_channels');

    expect(redirectDeferredToolCallRequest(makeRegistry(), request)).toEqual({
      ...request,
      name: ToolNames.TOOL_SEARCH,
      args: { query: 'select:mcp__time__get_unread_channels' },
    });
  });

  it('does not redirect once the deferred tool is revealed', () => {
    const request = makeRequest('mcp__time__get_unread_channels');
    const registry = makeRegistry({ revealDeferredTool: true });

    expect(redirectDeferredToolCallRequest(registry, request)).toBe(request);
  });

  it('does not redirect normal tools', () => {
    const request = makeRequest('read_file');

    expect(redirectDeferredToolCallRequest(makeRegistry(), request)).toBe(
      request,
    );
  });

  it('does not redirect when tool_search is unavailable', () => {
    const request = makeRequest('mcp__time__get_unread_channels');
    const registry = makeRegistry({ includeToolSearch: false });

    expect(redirectDeferredToolCallRequest(registry, request)).toBe(request);
  });
});

describe('redirectDeferredFunctionCall', () => {
  it('redirects unrevealed deferred ACP function calls to tool_search', () => {
    const functionCall: FunctionCall = {
      id: 'call-1',
      name: 'mcp__time__get_unread_channels',
      args: { original: true },
    };

    expect(redirectDeferredFunctionCall(makeRegistry(), functionCall)).toEqual({
      ...functionCall,
      name: ToolNames.TOOL_SEARCH,
      args: { query: 'select:mcp__time__get_unread_channels' },
    });
  });
});

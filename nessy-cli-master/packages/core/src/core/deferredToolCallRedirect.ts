/**
 * @license
 * Copyright 2026 Nessy
 * SPDX-License-Identifier: Apache-2.0
 */

// [nessy-fork] deferred-tool-call-redirect
import type { FunctionCall } from '@google/genai';
import type { ToolCallRequestInfo } from './turn.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { ToolNames, ToolNamesMigration } from '../tools/tool-names.js';

function canonicalToolName(toolName: string): string {
  return (
    ToolNamesMigration[toolName as keyof typeof ToolNamesMigration] ?? toolName
  );
}

function shouldRedirectDeferredToolCall(
  toolRegistry: ToolRegistry,
  toolName: string,
): boolean {
  const canonicalName = canonicalToolName(toolName);
  if (canonicalName === ToolNames.TOOL_SEARCH) {
    return false;
  }

  const tool = toolRegistry.getTool(canonicalName);
  if (!tool?.shouldDefer || tool.alwaysLoad) {
    return false;
  }

  if (toolRegistry.isDeferredToolRevealed(tool.name)) {
    return false;
  }

  return toolRegistry.getTool(ToolNames.TOOL_SEARCH) !== undefined;
}

export function redirectDeferredToolCallRequest(
  toolRegistry: ToolRegistry,
  request: ToolCallRequestInfo,
): ToolCallRequestInfo {
  if (!shouldRedirectDeferredToolCall(toolRegistry, request.name)) {
    return request;
  }

  return {
    ...request,
    name: ToolNames.TOOL_SEARCH,
    args: { query: `select:${canonicalToolName(request.name)}` },
  };
}

export function redirectDeferredFunctionCall(
  toolRegistry: ToolRegistry,
  functionCall: FunctionCall,
): FunctionCall {
  const name = functionCall.name;
  if (!name || !shouldRedirectDeferredToolCall(toolRegistry, name)) {
    return functionCall;
  }

  return {
    ...functionCall,
    name: ToolNames.TOOL_SEARCH,
    args: { query: `select:${canonicalToolName(name)}` },
  };
}

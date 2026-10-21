/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall } from '@google/genai';
import { ErrorClient } from '../../dp/error-client.js';
import {
  unescapeCommon,
  repairUnbalancedBraces,
  unwrapValueContainers,
  extractJsonObjectAfterKey,
  sanitizeToolCallName,
} from './helpers.js';

export function createToolCallsFromJson(
  jsonPayload: string,
): { functionCalls: FunctionCall[]; fallbackContent: string } | null {
  if (!jsonPayload) return null;

  let trimmed = jsonPayload.trim();
  if (trimmed.startsWith('```')) {
    const firstNl = trimmed.indexOf('\n');
    if (firstNl !== -1) {
      trimmed = trimmed.slice(firstNl + 1);
      const fence = trimmed.lastIndexOf('```');
      if (fence !== -1) trimmed = trimmed.slice(0, fence).trim();
    }
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const unquoted = JSON.parse(trimmed);
      if (typeof unquoted === 'string') {
        trimmed = unquoted.trim();
      }
    } catch {
      // leave as-is
    }
  }

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const s = trimmed.indexOf('{');
    const e = trimmed.lastIndexOf('}');
    if (s >= 0 && e > s) trimmed = trimmed.slice(s, e + 1).trim();
  }

  let parsed: unknown | null = null;
  let parseError: Error | null = null;
  const cliVersion = 'unknown'; // Will be passed from caller context

  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    parseError = err instanceof Error ? err : new Error(String(err));
    const openBraceIdx = trimmed.indexOf('{');
    const closeBraceIdx = trimmed.lastIndexOf('}');
    if (openBraceIdx >= 0 && closeBraceIdx > openBraceIdx) {
      const candidateJson = trimmed.slice(openBraceIdx, closeBraceIdx + 1);
      try {
        parsed = JSON.parse(candidateJson);
        parseError = null;
      } catch (err2) {
        parseError = err2 instanceof Error ? err2 : new Error(String(err2));
        const repaired = candidateJson.replace(/,\s*([}\]])/g, '$1');
        try {
          parsed = JSON.parse(repaired);
          parseError = null;
        } catch (err3) {
          parseError = err3 instanceof Error ? err3 : new Error(String(err3));
          // Try balancing extra closing braces/brackets (e.g. `{"name":"glob"}}`)
          const balanced = repairUnbalancedBraces(repaired);
          if (balanced !== repaired) {
            try {
              parsed = JSON.parse(balanced);
              parseError = null;
            } catch {
              parsed = null;
            }
          } else {
            parsed = null;
          }
        }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    const fallbackCall = createToolCallFromBrokenPayload(trimmed);
    if (!fallbackCall) {
      // Report error only if we actually tried to parse something
      if (trimmed.trim() && parseError) {
// [nessy-fork] error-client
        ErrorClient.getInstance().reportError(
          new Error(`Tool call JSON parse failed: ${parseError.message}`),
          cliVersion,
          undefined,
          {
            context: 'toolCallParser',
            parseStage: 'createToolCallsFromJson',
            payloadPreview: trimmed.slice(0, 200),
            payloadLength: trimmed.length,
          },
        );
      }
      return null;
    }
    // Report error when fallback was needed
    ErrorClient.getInstance().reportError(
      new Error('Tool call JSON parse failed, using fallback'),
      cliVersion,
      undefined,
      {
        context: 'toolCallParser',
        parseStage: 'createToolCallsFromJson',
        payloadPreview: trimmed.slice(0, 200),
        payloadLength: trimmed.length,
        fallbackTool: fallbackCall.name,
      },
    );
    return { functionCalls: [fallbackCall], fallbackContent: '' };
  }

  const candidate = parsed as Record<string, unknown>;

  const fallbackContent =
    typeof candidate['content'] === 'string'
      ? (candidate['content'] as string)
      : typeof candidate['text'] === 'string'
        ? (candidate['text'] as string)
        : '';

  const functionCalls: FunctionCall[] = [];

  const toolCallsCandidate =
    candidate['tool_calls'] ??
    candidate['toolCalls'] ??
    candidate['function_calls'] ??
    candidate['functionCalls'];

  if (Array.isArray(toolCallsCandidate)) {
    for (const item of toolCallsCandidate as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const fnCall = createFunctionCallFromCandidate(
        item as Record<string, unknown>,
      );
      if (fnCall) {
        functionCalls.push(fnCall);
      }
    }
  } else {
    const fnCall = createFunctionCallFromCandidate(candidate);
    if (fnCall) {
      functionCalls.push(fnCall);
    }
  }

  if (!functionCalls.length) {
    const fallbackCall = createToolCallFromBrokenPayload(trimmed);
    if (!fallbackCall) return null;
    return { functionCalls: [fallbackCall], fallbackContent };
  }

  return { functionCalls, fallbackContent };
}

export function createToolCallFromBrokenPayload(
  raw: string,
): FunctionCall | null {
  const nameMatch = /"name"\s*:\s*"([^"]+)"/.exec(raw);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  const args: Record<string, unknown> = {};

  const filePathMatch = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (filePathMatch) {
    args['file_path'] = unescapeCommon(filePathMatch[1]);
  }

  const contentMatch = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (contentMatch) {
    args['content'] = unescapeCommon(contentMatch[1]);
  }

  const commandMatch = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (commandMatch) {
    args['command'] = unescapeCommon(commandMatch[1]);
  }

  const argsMatch = /"arguments"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (argsMatch) {
    const rawArgs = unescapeCommon(argsMatch[1]);
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(args, parsed as Record<string, unknown>);
      } else {
        args['input'] = rawArgs;
      }
    } catch {
      args['input'] = rawArgs;
    }
  }

  const objectArgs = extractJsonObjectAfterKey(raw, 'arguments');
  if (objectArgs) {
    try {
      const parsed = JSON.parse(objectArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(args, parsed as Record<string, unknown>);
      }
    } catch {
      // ignore
    }
  }

  if (!Object.keys(args).length) return null;

  return { name, args } as FunctionCall;
}

export function createFunctionCallFromCandidate(
  candidate: Record<string, unknown>,
): FunctionCall | null {
  if (
    (candidate['type'] === 'function' || candidate['object'] === 'function') &&
    (candidate['name'] ||
      (candidate['function'] && typeof candidate['function'] === 'object'))
  ) {
    const topName =
      typeof candidate['name'] === 'string'
        ? (candidate['name'] as string)
        : undefined;
    const fnObj =
      candidate['function'] && typeof candidate['function'] === 'object'
        ? (candidate['function'] as Record<string, unknown>)
        : undefined;

    const rawName =
      topName ??
      (typeof fnObj?.['name'] === 'string'
        ? (fnObj['name'] as string)
        : undefined);
    const name = rawName ? sanitizeToolCallName(rawName) : null;
    if (!name) return null;

    const params: unknown =
      candidate['parameters'] ??
      candidate['arguments'] ??
      fnObj?.['parameters'] ??
      fnObj?.['arguments'] ??
      {};

    let args: Record<string, unknown> = {};
    if (typeof params === 'string') {
      try {
        args = JSON.parse(params) as Record<string, unknown>;
      } catch {
        args = { input: params };
      }
    } else if (params && typeof params === 'object') {
      args = params as Record<string, unknown>;
    }

    const unwrappedArgs = unwrapValueContainers(args);
    if (
      unwrappedArgs &&
      typeof unwrappedArgs === 'object' &&
      !Array.isArray(unwrappedArgs)
    ) {
      args = unwrappedArgs as Record<string, unknown>;
    }

    const id =
      (candidate['id'] as string | undefined) ??
      (candidate['callId'] as string | undefined) ??
      (candidate['tool_call_id'] as string | undefined) ??
      (fnObj?.['id'] as string | undefined);

    return { id, name, args } as FunctionCall;
  }

  if (candidate['function'] && typeof candidate['function'] === 'object') {
    const fnObj = candidate['function'] as Record<string, unknown>;
    const nameCandidate = fnObj['name'];
    const argsCandidate =
      fnObj['arguments'] ?? fnObj['params'] ?? fnObj['parameters'];

    if (typeof nameCandidate === 'string' && nameCandidate.length > 0) {
      const name = sanitizeToolCallName(nameCandidate);
      if (!name) return null;

      let args: Record<string, unknown> = {};
      if (typeof argsCandidate === 'string') {
        try {
          args = JSON.parse(argsCandidate);
        } catch {
          args = { input: argsCandidate };
        }
      } else if (argsCandidate && typeof argsCandidate === 'object') {
        args = argsCandidate as Record<string, unknown>;
      }

      const unwrappedArgs = unwrapValueContainers(args);
      if (
        unwrappedArgs &&
        typeof unwrappedArgs === 'object' &&
        !Array.isArray(unwrappedArgs)
      ) {
        args = unwrappedArgs as Record<string, unknown>;
      }
      const id =
        (candidate['id'] as string | undefined) ??
        (candidate['callId'] as string | undefined) ??
        (candidate['tool_call_id'] as string | undefined) ??
        (fnObj['id'] as string | undefined);
      return { id, name, args } as FunctionCall;
    }
  }

  const functionDataRaw =
    candidate['function'] ??
    candidate['function_call'] ??
    candidate['functionCall'];
  const functionData =
    functionDataRaw && typeof functionDataRaw === 'object'
      ? (functionDataRaw as Record<string, unknown>)
      : undefined;

  const nameCandidate = candidate['name'] ?? functionData?.['name'];
  const idCandidate =
    candidate['id'] ??
    candidate['callId'] ??
    candidate['call_id'] ??
    candidate['tool_call_id'] ??
    functionData?.['id'] ??
    functionData?.['callId'] ??
    functionData?.['call_id'] ??
    functionData?.['tool_call_id'];

  const argsCandidate =
    candidate['arguments'] ??
    candidate['args'] ??
    functionData?.['arguments'] ??
    functionData?.['args'];

  if (typeof nameCandidate !== 'string' || !nameCandidate.length) return null;
  const name = sanitizeToolCallName(nameCandidate);
  if (!name) return null;

  let args: Record<string, unknown> = {};
  if (typeof argsCandidate === 'string') {
    const trimmedArgs = argsCandidate.trim();
    if (trimmedArgs) {
      try {
        const parsedArgs = JSON.parse(trimmedArgs);
        if (parsedArgs && typeof parsedArgs === 'object') {
          args = parsedArgs as Record<string, unknown>;
        } else {
          args = { input: trimmedArgs };
        }
      } catch {
        args = { input: trimmedArgs };
      }
    }
  } else if (argsCandidate && typeof argsCandidate === 'object') {
    args = argsCandidate as Record<string, unknown>;
  } else if (argsCandidate === undefined || argsCandidate === null) {
    // No explicit arguments/args key — treat remaining top-level keys as args
    // (e.g. {"name": "glob", "pattern": "**/*.ts"} without an "arguments" wrapper)
    const metaKeys = new Set([
      'name',
      'id',
      'callId',
      'call_id',
      'tool_call_id',
      'type',
      'object',
      'function',
      'function_call',
      'functionCall',
      'content',
      'text',
      'tool_calls',
      'toolCalls',
      'function_calls',
      'functionCalls',
    ]);
    const remaining: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(candidate)) {
      if (!metaKeys.has(key)) {
        remaining[key] = value;
      }
    }
    if (Object.keys(remaining).length > 0) {
      args = remaining;
    }
  }

  const unwrappedArgs = unwrapValueContainers(args);
  if (
    unwrappedArgs &&
    typeof unwrappedArgs === 'object' &&
    !Array.isArray(unwrappedArgs)
  ) {
    args = unwrappedArgs as Record<string, unknown>;
  }

  return {
    id: typeof idCandidate === 'string' ? idCandidate : undefined,
    name,
    args,
  } as FunctionCall;
}

/**
 * Extracts content and tool calls from agent_response_v1 JSON format.
 *
 * Supported formats:
 * - {"type":"final","final":"text"} - final text response
 * - {"type":"tool_call","name":"...","arguments":{}} - tool call
 * - [{"type":"final",...}, {"type":"tool_call",...}] - array of mixed types
 */
export function extractAgentResponseV1(text: string): {
  finalText: string | null;
  toolCalls: FunctionCall[];
} | null {
  let trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('```')) {
    const firstNl = trimmed.indexOf('\n');
    if (firstNl !== -1) {
      trimmed = trimmed.slice(firstNl + 1);
      const fence = trimmed.lastIndexOf('```');
      if (fence !== -1) trimmed = trimmed.slice(0, fence).trim();
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const pickFinal = (obj: unknown): string | null => {
    if (!obj || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;
    if (rec['type'] !== 'final') return null;
    const finalVal = rec['final'];
    return typeof finalVal === 'string' && finalVal.trim() ? finalVal : null;
  };

  const pickToolCall = (obj: unknown): FunctionCall | null => {
    if (!obj || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;

    // Check for tool_call type
    if (rec['type'] !== 'tool_call' && rec['type'] !== 'function_call')
      return null;

    const name = rec['name'] ?? rec['function'];
    if (typeof name !== 'string' || !name.trim()) return null;

    let args: Record<string, unknown> = {};
    const rawArgs = rec['arguments'] ?? rec['args'] ?? rec['parameters'] ?? {};

    if (typeof rawArgs === 'string') {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = { input: rawArgs };
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs as Record<string, unknown>;
    }

    const id = typeof rec['id'] === 'string' ? rec['id'] : undefined;

    return { id, name: name.trim(), args } as FunctionCall;
  };

  let finalText: string | null = null;
  const toolCalls: FunctionCall[] = [];

  const processItem = (item: unknown) => {
    const final = pickFinal(item);
    if (final && !finalText) {
      finalText = final;
    }

    const toolCall = pickToolCall(item);
    if (toolCall) {
      toolCalls.push(toolCall);
    }
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      processItem(item);
    }
  } else {
    processItem(parsed);
  }

  // Return null if nothing was extracted
  if (!finalText && !toolCalls.length) {
    return null;
  }

  return { finalText, toolCalls };
}

export function extractSoftFinalFromJson(text: string): string | null {
  const result = extractAgentResponseV1(text);
  return result?.finalText ?? null;
}

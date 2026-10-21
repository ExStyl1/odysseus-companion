/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall } from '@google/genai';
import { safeJsonParse } from '../safeJsonParse.js';
import type { ToolCallParseResult, ToolCallParseSegment } from './types.js';
import {
  unescapeCommon,
  normalizeQuotes,
  stripCodeFence,
  extractSingleArgString,
  createShortDescription,
  extractJsonObjectAfterKey,
} from './helpers.js';
import {
  createToolCallsFromJson,
  extractSoftFinalFromJson,
} from './jsonParser.js';

// Parses "path '...'/\"...\"/`...` with content '...'" -> { path: "...", content: "..." }
export function parseKeyValueArgString(s: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const normalized = normalizeQuotes(s);
  // Allow "for ... with ... and ..." - ignore connector words.
  const re = /\b([a-zA-Z0-9_./:-]+)\s+(['"`])([\s\S]*?)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const key = m[1].toLowerCase();
    if (key === 'with' || key === 'and' || key === 'for' || key === 'equals') {
      continue;
    }
    const val = unescapeCommon((m[3] ?? '').trim());
    args[key] = val;
  }
  return args;
}

export function parseForWithArguments(
  raw: string,
): { target: string; argText: string } | null {
  const normalized = normalizeQuotes(raw).trim();
  const match = /^(['"`])([\s\S]*?)\1\s+with\s+arguments\s+([\s\S]+)$/i.exec(
    normalized,
  );
  if (!match) return null;
  return {
    target: unescapeCommon(match[2].trim()),
    argText: match[3].trim(),
  };
}

export function parseLooseObject(raw: string): Record<string, unknown> | null {
  const text = normalizeQuotes(raw).trim();
  if (!text) return null;
  if (!text.startsWith('{') || !text.endsWith('}')) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // continue
  }

  const singleToDouble = text.replace(
    /'([^'\\]*(?:\\.[^'\\]*)*)'/g,
    (_match, inner: string) => `"${inner.replace(/"/g, '\\"')}"`,
  );

  try {
    const parsed = JSON.parse(singleToDouble);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

export function parseTodoWriteArgs(
  rawAfterFor: string,
): Record<string, unknown> | null {
  const normalized = normalizeQuotes(rawAfterFor);
  const markerMatch = /\btodos?\s*:\s*/i.exec(normalized);
  const listSource = markerMatch
    ? normalized.slice(markerMatch.index + markerMatch[0].length)
    : normalized;

  const todos = parseTodoLines(listSource);
  if (!todos.length) return null;
  return { todos };
}

export function parseTodoLines(
  text: string,
): Array<{ id: string; content: string; status: string }> {
  const lines = text.split('\n');
  const todos: Array<{ id: string; content: string; status: string }> = [];
  let idx = 1;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = /^(?:\d+[).\s-]|[-*+]\s+)(.+)$/.exec(line);
    const payload = (m ? m[1] : line).trim();
    if (!payload) continue;

    const { content, status } = extractTodoStatus(payload);
    if (!content) continue;

    todos.push({
      id: `todo-${idx}`,
      content,
      status,
    });
    idx += 1;
  }

  return todos;
}

export function extractTodoStatus(payload: string): {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
} {
  const statusMatch =
    /(?:\s*[-–—]\s*|\s*\[\s*|\s*\(\s*)(pending|in_progress|completed|in progress)\s*(?:\]|\))?\s*$/i.exec(
      payload,
    );

  if (!statusMatch) {
    return { content: payload.trim(), status: 'pending' };
  }

  const rawStatus = statusMatch[1].toLowerCase().replace(/\s+/g, '_');
  const status =
    rawStatus === 'in_progress' || rawStatus === 'completed'
      ? (rawStatus as 'in_progress' | 'completed')
      : 'pending';

  const content = payload.slice(0, statusMatch.index).trim();
  return { content, status };
}

export function tryParseBracketToolCalls(text: string): FunctionCall[] {
  const calls: FunctionCall[] = [];
  const outer = /\[tool_call:\s*([\w.:/-]+)([\s\S]*?)]/gi;
  let m: RegExpExecArray | null;

  while ((m = outer.exec(text)) !== null) {
    const name = m[1];
    const tail = (m[2] ?? '').trim();
    let args: Record<string, unknown> = {};

    const forMatch = /\bfor\b([\s\S]*)$/i.exec(tail);
    const rawAfterFor = forMatch ? forMatch[1].trim() : '';

    if (rawAfterFor) {
      const namedArgs = parseForWithArguments(rawAfterFor);
      if (namedArgs) {
        const parsedArgs = parseLooseObject(namedArgs.argText) ?? {};

        if (name === 'task') {
          const taskArgs: Record<string, unknown> = { ...parsedArgs };
          if (!('subagent_type' in taskArgs)) {
            taskArgs['subagent_type'] = namedArgs.target;
          }

          let prompt = '';
          if (typeof taskArgs['prompt'] === 'string') {
            prompt = taskArgs['prompt'] as string;
          } else if (typeof taskArgs['query'] === 'string') {
            prompt = taskArgs['query'] as string;
            taskArgs['prompt'] = prompt;
          }

          if (!('description' in taskArgs)) {
            taskArgs['description'] = createShortDescription(
              prompt || namedArgs.target,
            );
          }

          args = taskArgs;
        } else if (Object.keys(parsedArgs).length > 0) {
          args = { input: namedArgs.target, ...parsedArgs };
        } else {
          args = { input: namedArgs.target };
        }
      }

      if (name === 'todo_write' && !Object.keys(args).length) {
        const todoArgs = parseTodoWriteArgs(rawAfterFor);
        if (todoArgs) {
          args = todoArgs;
        }
      }

      if (!Object.keys(args).length && name === 'read_file') {
        const filePath = extractSingleArgString(rawAfterFor);
        if (filePath) {
          args = { absolute_path: filePath };
        }
      }

      if (!Object.keys(args).length) {
        const normalized = normalizeQuotes(rawAfterFor);
        const argsMatch = /\barguments\b\s+([\s\S]+)$/i.exec(normalized);
        const argText = argsMatch ? argsMatch[1].trim() : normalized;
        const looseArgs = parseLooseObject(argText);
        if (looseArgs) {
          args = looseArgs;
        }
      }

      if (!Object.keys(args).length) {
        const normalized = normalizeQuotes(rawAfterFor);
        const q = /^(['"`])([\s\S]*?)\1\s*$/.exec(normalized);
        if (q) {
          const rawArg = (q[2] ?? '').trim();
          try {
            const maybe = JSON.parse(rawArg);
            if (maybe && typeof maybe === 'object') {
              args = maybe as Record<string, unknown>;
            } else {
              args = { input: unescapeCommon(rawArg) };
            }
          } catch {
            args = { input: unescapeCommon(rawArg) };
          }
        } else {
          const kv = parseKeyValueArgString(normalized);
          if (Object.keys(kv).length > 0) {
            args = kv;
          } else {
            args = { input: unescapeCommon(normalized) };
          }
        }
      }
    }

    if (
      name === 'run_shell_command' &&
      'input' in args &&
      typeof args['input'] === 'string'
    ) {
      const command = args['input'] as string;
      args = { command, is_background: false };
    }

    calls.push({ name, args } as FunctionCall);
  }

  return calls;
}

export function tryParseBareFunctionJson(text: string): ToolCallParseResult {
  const functionCalls: FunctionCall[] = [];
  const segments: ToolCallParseSegment[] = [];
  const s = stripCodeFence(text);
  const trimmed = s.trim();

  if (!/^[[{]/.test(trimmed)) {
    if (text) {
      segments.push({ type: 'content', value: text });
    }
    return { functionCalls, content: text, segments };
  }

  if (!s.includes('{') || !s.includes('}')) {
    if (text) {
      segments.push({ type: 'content', value: text });
    }
    return { functionCalls, content: text, segments };
  }

  const softFinal = extractSoftFinalFromJson(s);
  if (softFinal) {
    segments.push({ type: 'content', value: softFinal });
    return { functionCalls, content: softFinal, segments };
  }

  const parsed = createToolCallsFromJson(s);
  if (!parsed || !parsed.functionCalls.length) {
    if (text) {
      segments.push({ type: 'content', value: text });
    }
    return { functionCalls, content: text, segments };
  }

  functionCalls.push(...parsed.functionCalls);
  for (const call of parsed.functionCalls) {
    segments.push({ type: 'tool_call', value: call });
  }

  const content =
    parsed.fallbackContent && !/^\s*[{[]/.test(parsed.fallbackContent)
      ? parsed.fallbackContent
      : '';

  if (content) {
    segments.push({ type: 'content', value: content });
  }

  return { functionCalls, content, segments };
}

export function tryParseTaggedToolCalls(text: string): FunctionCall[] {
  const calls: FunctionCall[] = [];
  const functionRe = /<function=([^>]+)>([\s\S]*?)<\/function>/gi;
  let match: RegExpExecArray | null;

  while ((match = functionRe.exec(text)) !== null) {
    const name = (match[1] ?? '').trim();
    if (!name) continue;

    const body = match[2] ?? '';
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi;
    let paramMatch: RegExpExecArray | null;

    while ((paramMatch = paramRe.exec(body)) !== null) {
      const key = (paramMatch[1] ?? '').trim();
      if (!key) continue;
      const value = (paramMatch[2] ?? '').trim();
      args[key] = unescapeCommon(value);
    }

    if (!Object.keys(args).length) {
      const trimmed = stripCodeFence(body).trim();
      if (trimmed) {
        args['input'] = unescapeCommon(trimmed);
      }
    }

    calls.push({ name, args } as FunctionCall);
  }

  return calls;
}

/**
 * Detect `<function_name>{json}</function_name>` patterns where the tag name
 * itself is the tool name and the body is a JSON object/array of arguments.
 * Skips common HTML/XML tags whose body does not start with `{` or `[`.
 */
export function tryParseNamedTagToolCalls(
  text: string,
): ToolCallParseResult | null {
  const re = /<([a-z_]\w*?)>\s*([\s\S]*?)\s*<\/\1>/gi;
  const functionCalls: FunctionCall[] = [];
  const segments: ToolCallParseSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const tagName = match[1];
    const body = (match[2] ?? '').trim();

    // Skip if body doesn't look like JSON
    if (!body.startsWith('{') && !body.startsWith('[')) continue;

    // Skip common non-tool tags
    if (['tool_call', 'function', 'parameter'].includes(tagName.toLowerCase()))
      continue;

    const parsed = safeJsonParse(
      body,
      null as unknown as Record<string, unknown>,
    );
    if (parsed === null || typeof parsed !== 'object') continue;

    // Capture text before this match as content
    const beforeText = text.slice(lastIndex, match.index);
    if (beforeText.trim()) {
      segments.push({ type: 'content', value: beforeText });
    }

    const call: FunctionCall = { name: tagName, args: parsed } as FunctionCall;
    functionCalls.push(call);
    segments.push({ type: 'tool_call', value: call });
    lastIndex = match.index + match[0].length;
  }

  if (!functionCalls.length) return null;

  // Capture any trailing text
  const trailing = text.slice(lastIndex);
  if (trailing.trim()) {
    segments.push({ type: 'content', value: trailing });
  }

  const contentParts = segments
    .filter((s) => s.type === 'content')
    .map((s) => s.value)
    .join('');

  return { functionCalls, content: contentParts, segments };
}

export function processBracketToolCallText(text: string): ToolCallParseResult {
  const functionCalls: FunctionCall[] = [];
  const segments: ToolCallParseSegment[] = [];
  const outer = /\[tool_call:\s*([\w.:/-]+)([\s\S]*?)]/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = outer.exec(text)) !== null) {
    const before = text.slice(cursor, match.index);
    if (before) {
      segments.push({ type: 'content', value: before });
    }

    const calls = tryParseBracketToolCalls(match[0]);
    for (const call of calls) {
      functionCalls.push(call);
      segments.push({ type: 'tool_call', value: call });
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    const tail = text.slice(cursor);
    if (tail) {
      segments.push({ type: 'content', value: tail });
    }
  }

  const content = segments
    .filter((segment) => segment.type === 'content')
    .map((segment) => segment.value)
    .join('');

  return { functionCalls, content, segments };
}

/**
 * Handles broken payloads that mix a malformed JSON name declaration with
 * XML-style parameter blocks. Example:
 *   {"name="mcp__fs__get_file_info>
 *   <parameter=path>C:\Users\...\file.json</parameter>
 *   </function>
 */
export function tryParseBrokenToolCallPayload(
  payload: string,
): FunctionCall | null {
  const nameMatch =
    /\{"name="([^">\s,}]+)/.exec(payload) ??
    /\{"name\s*=\s*["']?([^"'>\s,}]+)/.exec(payload);
  if (!nameMatch) return null;

  const name = nameMatch[1].trim();
  if (!name) return null;

  const args: Record<string, unknown> = {};
  const paramRe = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let paramMatch: RegExpExecArray | null;

  while ((paramMatch = paramRe.exec(payload)) !== null) {
    const key = (paramMatch[1] ?? '').trim();
    if (!key) continue;
    args[key] = unescapeCommon((paramMatch[2] ?? '').trim());
  }

  if (!Object.keys(args).length) return null;

  return { name, args } as FunctionCall;
}

/**
 * Handles broken JSON where `"name"` uses `=` instead of `:` but `"arguments"`
 * is valid JSON. Example from nessy models:
 *   {"name="mcp__time__send-message","arguments":{"peer":"user","text":"hello"}}
 */
export function tryParseEqualsSignNameJson(
  payload: string,
): FunctionCall | null {
  // Match "name=" (with = instead of :) followed by a value, then valid "arguments":{...}
  const nameMatch =
    /["']name["']\s*=\s*["']?([^"'>,}\s]+)["']?/.exec(payload) ??
    /\{"name="([^">\s,}]+)/.exec(payload);
  if (!nameMatch) return null;

  const name = nameMatch[1].trim();
  if (!name) return null;

  // Extract "arguments":{...} as a JSON object
  const argsJson = extractJsonObjectAfterKey(payload, 'arguments');
  if (argsJson) {
    try {
      const parsed = JSON.parse(argsJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { name, args: parsed } as FunctionCall;
      }
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Handles broken payloads where the tool name uses `{"function=TOOL_NAME>`
 * instead of `<function=TOOL_NAME>` or `{"name":"TOOL_NAME"}`, combined with
 * XML-style `<parameter>` blocks for arguments. Example from nessy models:
 *   {"function=run_shell_command>
 *   <parameter=command>ls -la</parameter>
 *   <parameter=is_background>False</parameter>
 *   </function>
 */
export function tryParseBrokenFunctionEqualsPayload(
  payload: string,
): FunctionCall | null {
  const nameMatch = /\{?"?function\s*=\s*["']?([^"'>\s,}]+)/i.exec(payload);
  if (!nameMatch) return null;

  const name = nameMatch[1].trim();
  if (!name) return null;

  const args: Record<string, unknown> = {};
  const paramRe = /<parameter=["']?([^"'>]+)["']?>([\s\S]*?)<\/parameter>/gi;
  let paramMatch: RegExpExecArray | null;

  while ((paramMatch = paramRe.exec(payload)) !== null) {
    const key = (paramMatch[1] ?? '').trim();
    if (!key) continue;
    args[key] = unescapeCommon((paramMatch[2] ?? '').trim());
  }

  const objectArgs = extractJsonObjectAfterKey(payload, 'arguments');
  if (objectArgs) {
    try {
      const parsed = JSON.parse(objectArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(args, parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed inline arguments and fall back to parameter blocks.
    }
  }

  if (!Object.keys(args).length) return null;

  return { name, args } as FunctionCall;
}

/**
 * Handles broken payloads where `"name":"TOOL_NAME` bleeds into XML `>`
 * and arguments come from `<parameter>` blocks. The parameter key may be
 * wrapped in quotes. Example from nessy models:
 *   {"name":"read_file>
 *   <parameter="file_path">/some/path</parameter>
 *   </function>
 */
export function tryParseBrokenNameColonWithParams(
  payload: string,
): FunctionCall | null {
  // Match "name":"value> or "name": "value> where value has no closing quote
  const nameMatch = /"name"\s*:\s*"?([^">\s,}]+)>/.exec(payload);
  if (!nameMatch) return null;

  const name = nameMatch[1].trim();
  if (!name) return null;

  const args: Record<string, unknown> = {};
  const paramRe = /<parameter=["']?([^"'>]+)["']?>([\s\S]*?)<\/parameter>/gi;
  let paramMatch: RegExpExecArray | null;

  while ((paramMatch = paramRe.exec(payload)) !== null) {
    const key = (paramMatch[1] ?? '').trim();
    if (!key) continue;
    args[key] = unescapeCommon((paramMatch[2] ?? '').trim());
  }

  if (!Object.keys(args).length) return null;

  return { name, args } as FunctionCall;
}

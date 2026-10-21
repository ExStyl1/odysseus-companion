/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../debugLogger.js';
import {
  OPEN_TAG,
  CLOSE_TAG,
  MAX_RAW,
  NAMED_TAG_STREAM_RE,
} from './constants.js';
import type { ToolCallParseResult, ToolCallParseSegment } from './types.js';
import {
  findToolCallMarkersOutsideStrings,
  hasUnclosedToolCallTag,
  splitOnUnclosedToolCallTag,
  hasUnclosedBracketToolCall,
  splitOnUnclosedBracketToolCall,
  hasUnclosedNamedToolTag,
  splitOnUnclosedNamedToolTag,
} from './tagDetection.js';
import { createToolCallsFromJson } from './jsonParser.js';
import {
  tryParseBareFunctionJson,
  tryParseTaggedToolCalls,
  tryParseNamedTagToolCalls,
  processBracketToolCallText,
  tryParseBrokenToolCallPayload,
  tryParseEqualsSignNameJson,
  tryParseBrokenFunctionEqualsPayload,
  tryParseBrokenNameColonWithParams,
} from './strategies.js';
import { deepEqual } from './helpers.js';

export { OPEN_TAG, CLOSE_TAG, MAX_RAW, NAMED_TAG_STREAM_RE };
export { sanitizeToolCallName } from './helpers.js';
export type {
  ToolCallParseResult,
  ToolCallParseSegment,
  ToolCallMarker,
  ValueContainer,
} from './types.js';

const debugLogger = createDebugLogger('TOOL_CALL_PARSER');

export function stripToolCallsFromText(text: string): string {
  if (!text) return '';
  const result = processToolCallText(text);
  if (result.segments && result.segments.length) {
    return result.segments
      .filter((segment) => segment.type === 'content')
      .map((segment) => segment.value)
      .join('');
  }
  return result.content ?? text;
}

export class ToolCallStreamParser {
  private toolCallRawBuffer = '';

  reset(): void {
    this.toolCallRawBuffer = '';
  }

  parseChunk(text: string): ToolCallParseResult {
    if (!text) {
      return { functionCalls: [], content: '', segments: [] };
    }

    const hasNamedToolTag = NAMED_TAG_STREAM_RE.test(text);
    const hasToolMarkers =
      text.includes(OPEN_TAG) ||
      text.includes('[tool_call:') ||
      hasNamedToolTag;

    if (hasToolMarkers || this.toolCallRawBuffer) {
      this.toolCallRawBuffer += text;
      if (this.toolCallRawBuffer.length > MAX_RAW) {
        this.toolCallRawBuffer = this.toolCallRawBuffer.slice(-MAX_RAW);
      }

      const splitTagged = splitOnUnclosedToolCallTag(this.toolCallRawBuffer);
      if (splitTagged) {
        const { complete, remainder } = splitTagged;
        this.toolCallRawBuffer = remainder;
        if (complete) {
          return processToolCallText(complete);
        }
        return { functionCalls: [], content: '', segments: [] };
      }

      const splitBracket = splitOnUnclosedBracketToolCall(
        this.toolCallRawBuffer,
      );
      if (splitBracket) {
        const { complete, remainder } = splitBracket;
        this.toolCallRawBuffer = remainder;
        if (complete) {
          return processToolCallText(complete);
        }
        return { functionCalls: [], content: '', segments: [] };
      }

      if (this.toolCallRawBuffer.includes(CLOSE_TAG)) {
        const result = processToolCallText(this.toolCallRawBuffer);
        this.toolCallRawBuffer = '';
        return result;
      }

      if (
        this.toolCallRawBuffer.includes('[tool_call:') &&
        this.toolCallRawBuffer.includes(']')
      ) {
        const result = processToolCallText(this.toolCallRawBuffer);
        this.toolCallRawBuffer = '';
        return result;
      }

      // Check for unclosed snake_case named tags (e.g. <todo_write> without </todo_write>)
      const splitNamed = splitOnUnclosedNamedToolTag(this.toolCallRawBuffer);
      if (splitNamed) {
        const { complete, remainder } = splitNamed;
        this.toolCallRawBuffer = remainder;
        if (complete) {
          return processToolCallText(complete);
        }
        return { functionCalls: [], content: '', segments: [] };
      }

      // Check if buffer has complete named tags that can be parsed now
      const namedTagResult = tryParseNamedTagToolCalls(this.toolCallRawBuffer);
      if (namedTagResult && namedTagResult.functionCalls.length > 0) {
        this.toolCallRawBuffer = '';
        return namedTagResult;
      }

      return { functionCalls: [], content: '', segments: [] };
    }

    return tryParseBareFunctionJson(text);
  }

  flush(): ToolCallParseResult {
    if (!this.toolCallRawBuffer) {
      return { functionCalls: [], content: '', segments: [] };
    }

    const result = processToolCallText(this.toolCallRawBuffer);
    debugLogger.debug(
      `flush result: functionCalls=${result.functionCalls.length}, contentLen=${result.content?.length ?? 0}`,
    );
    this.toolCallRawBuffer = '';
    return result;
  }

  get hasTruncatedToolCall(): boolean {
    if (!this.toolCallRawBuffer) return false;
    if (hasUnclosedToolCallTag(this.toolCallRawBuffer)) return true;
    if (hasUnclosedBracketToolCall(this.toolCallRawBuffer)) return true;
    return hasUnclosedNamedToolTag(this.toolCallRawBuffer);
  }
}

export function processToolCallText(text: string): ToolCallParseResult {
  const functionCalls: Array<import('@google/genai').FunctionCall> = [];
  const segments: ToolCallParseSegment[] = [];

  const hasOpenTag = text.includes(OPEN_TAG);
  const hasBracket = text.includes('[tool_call:');

  if (!hasOpenTag && !hasBracket) {
    // Check for <tool_name>{json}</tool_name> format (e.g., <todo_write>)
    const namedTagResult = tryParseNamedTagToolCalls(text);
    if (namedTagResult && namedTagResult.functionCalls.length > 0) {
      debugLogger.debug(
        `processToolCallText: found ${namedTagResult.functionCalls.length} named tag tool calls: ${namedTagResult.functionCalls.map((fc) => fc.name).join(', ')}`,
      );
      return namedTagResult;
    }

    if (text) {
      segments.push({ type: 'content', value: text });
    }
    return { functionCalls: [], content: text, segments };
  }

  type Pair = { open: number; close: number };
  const pairs: Pair[] = [];
  const stack: number[] = [];
  const markers = findToolCallMarkersOutsideStrings(text, OPEN_TAG, CLOSE_TAG);

  for (const marker of markers) {
    if (marker.type === 'open') {
      stack.push(marker.index);
    } else if (stack.length > 0) {
      const openIdx = stack.pop()!;
      pairs.push({ open: openIdx, close: marker.index });
    }
  }

  if (!pairs.length) {
    if (text.includes(OPEN_TAG) && text.includes(CLOSE_TAG)) {
      const loose = tryParseToolCallTagBlocks(text);
      if (loose && loose.functionCalls.length) {
        return loose;
      }
    }

    const taggedCalls = tryParseTaggedToolCalls(text);
    if (taggedCalls.length) {
      for (const call of taggedCalls) {
        segments.push({ type: 'tool_call', value: call });
      }
      return { functionCalls: taggedCalls, content: '', segments };
    }

    const lastOpenIdx = text.lastIndexOf(OPEN_TAG);

    if (lastOpenIdx !== -1) {
      const beforeToolCall = text.slice(0, lastOpenIdx);
      const afterToolCall = text.slice(lastOpenIdx + OPEN_TAG.length);
      const { functionCalls: tailCalls, content: tailContent } =
        tryParseBareFunctionJson(afterToolCall);

      if (tailCalls.length > 0) {
        if (beforeToolCall) {
          segments.push({ type: 'content', value: beforeToolCall });
        }
        for (const call of tailCalls) {
          segments.push({ type: 'tool_call', value: call });
        }
        if (tailContent) {
          segments.push({ type: 'content', value: tailContent });
        }
        return {
          functionCalls: tailCalls,
          content: beforeToolCall + (tailContent ?? ''),
          segments,
        };
      }
    }

    const { functionCalls: bareCalls } = tryParseBareFunctionJson(text);
    if (bareCalls.length) {
      for (const call of bareCalls) {
        segments.push({ type: 'tool_call', value: call });
      }
      return { functionCalls: bareCalls, content: '', segments };
    }

    const bracketResult = processBracketToolCallText(text);
    if (bracketResult.functionCalls.length) {
      return bracketResult;
    }

    // Handle malformed tags: <tool_call>{json}<tool_call> (missing slash in closing tag)
    // or <tool_call>{json} (no closing tag at all)
    if (text.includes(OPEN_TAG) && !text.includes(CLOSE_TAG)) {
      const malformedResult = tryParseMalformedToolCallTags(text);
      if (malformedResult && malformedResult.functionCalls.length) {
        return malformedResult;
      }
    }

    if (text) {
      segments.push({ type: 'content', value: text });
    }
    return { functionCalls: [], content: text, segments };
  }

  const outerPairs = pairs.filter(
    (p) =>
      !pairs.some(
        (other) =>
          other !== p && other.open <= p.open && other.close >= p.close,
      ),
  );

  outerPairs.sort((a, b) => a.open - b.open);

  const stripInnerTags = (s: string) => {
    const innerMarkers = findToolCallMarkersOutsideStrings(
      s,
      OPEN_TAG,
      CLOSE_TAG,
    );
    if (!innerMarkers.length) return s;

    let cursor = 0;
    let result = '';

    for (const marker of innerMarkers) {
      result += s.slice(cursor, marker.index);
      cursor =
        marker.index +
        (marker.type === 'open' ? OPEN_TAG.length : CLOSE_TAG.length);
    }

    result += s.slice(cursor);
    return result;
  };

  let cursor = 0;
  let content = '';

  for (const p of outerPairs) {
    if (cursor < p.open) {
      const chunk = text.slice(cursor, p.open);
      if (chunk) {
        content += chunk;
        segments.push({ type: 'content', value: chunk });
      }
    }

    const rawPayload = text.slice(p.open + OPEN_TAG.length, p.close).trim();
    const sanitized = stripInnerTags(rawPayload);
    const result = createToolCallsFromJson(sanitized);

    if (!result) {
      const taggedCalls = tryParseTaggedToolCalls(sanitized);
      if (taggedCalls.length) {
        functionCalls.push(...taggedCalls);
        for (const call of taggedCalls) {
          segments.push({ type: 'tool_call', value: call });
        }
        cursor = p.close + CLOSE_TAG.length;
        continue;
      }

      const { functionCalls: bareCalls, content: bareContent } =
        tryParseBareFunctionJson(sanitized);

      if (bareCalls.length) {
        functionCalls.push(...bareCalls);
        for (const call of bareCalls) {
          segments.push({ type: 'tool_call', value: call });
        }
        if (bareContent) {
          content += bareContent;
          segments.push({ type: 'content', value: bareContent });
        }
        cursor = p.close + CLOSE_TAG.length;
        continue;
      }

      const brokenCall = tryParseBrokenToolCallPayload(sanitized);
      if (brokenCall) {
        functionCalls.push(brokenCall);
        segments.push({ type: 'tool_call', value: brokenCall });
        cursor = p.close + CLOSE_TAG.length;
        continue;
      }

      const equalsCall = tryParseEqualsSignNameJson(sanitized);
      if (equalsCall) {
        functionCalls.push(equalsCall);
        segments.push({ type: 'tool_call', value: equalsCall });
        cursor = p.close + CLOSE_TAG.length;
        continue;
      }

      const funcEqualsCall = tryParseBrokenFunctionEqualsPayload(sanitized);
      if (funcEqualsCall) {
        functionCalls.push(funcEqualsCall);
        segments.push({ type: 'tool_call', value: funcEqualsCall });
        cursor = p.close + CLOSE_TAG.length;
        continue;
      }

      const nameColonCall = tryParseBrokenNameColonWithParams(sanitized);
      if (nameColonCall) {
        functionCalls.push(nameColonCall);
        segments.push({ type: 'tool_call', value: nameColonCall });
        cursor = p.close + CLOSE_TAG.length;
        continue;
      }
    }

    if (result) {
      functionCalls.push(...result.functionCalls);
      for (const call of result.functionCalls) {
        segments.push({ type: 'tool_call', value: call });
      }
      if (result.fallbackContent && !/^\s*[{[]/.test(result.fallbackContent)) {
        content += result.fallbackContent;
        segments.push({ type: 'content', value: result.fallbackContent });
      }
    } else {
      const rawChunk = text.slice(p.open, p.close + CLOSE_TAG.length);
      if (rawChunk) {
        content += rawChunk;
        segments.push({ type: 'content', value: rawChunk });
      }
    }

    cursor = p.close + CLOSE_TAG.length;
  }

  if (cursor < text.length) {
    const tail = text.slice(cursor);
    if (tail) {
      content += tail;
      segments.push({ type: 'content', value: tail });
    }
  }

  if (!functionCalls.length) {
    const bracketResult = processBracketToolCallText(text);
    if (bracketResult.functionCalls.length) {
      return bracketResult;
    }
  }

  return { functionCalls, content, segments };
}

function tryParseToolCallTagBlocks(text: string): ToolCallParseResult | null {
  const functionCalls: Array<import('@google/genai').FunctionCall> = [];
  const segments: ToolCallParseSegment[] = [];
  const outer = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = outer.exec(text)) !== null) {
    const before = text.slice(cursor, match.index);
    if (before) {
      segments.push({ type: 'content', value: before });
    }

    const payload = (match[1] ?? '').trim();
    const parsed = payload ? createToolCallsFromJson(payload) : null;

    if (!parsed || !parsed.functionCalls.length) {
      const bare = payload ? tryParseBareFunctionJson(payload) : null;
      if (bare && bare.functionCalls.length) {
        functionCalls.push(...bare.functionCalls);
        for (const call of bare.functionCalls) {
          segments.push({ type: 'tool_call', value: call });
        }
        if (bare.content) {
          segments.push({ type: 'content', value: bare.content });
        }
      } else {
        const brokenCall = payload
          ? tryParseBrokenToolCallPayload(payload)
          : null;
        if (brokenCall) {
          functionCalls.push(brokenCall);
          segments.push({ type: 'tool_call', value: brokenCall });
        } else {
          const equalsCall = payload
            ? tryParseEqualsSignNameJson(payload)
            : null;
          if (equalsCall) {
            functionCalls.push(equalsCall);
            segments.push({ type: 'tool_call', value: equalsCall });
          } else {
            const funcEqualsCall = payload
              ? tryParseBrokenFunctionEqualsPayload(payload)
              : null;
            if (funcEqualsCall) {
              functionCalls.push(funcEqualsCall);
              segments.push({ type: 'tool_call', value: funcEqualsCall });
            } else {
              const nameColonCall = payload
                ? tryParseBrokenNameColonWithParams(payload)
                : null;
              if (nameColonCall) {
                functionCalls.push(nameColonCall);
                segments.push({ type: 'tool_call', value: nameColonCall });
              } else {
                segments.push({ type: 'content', value: match[0] });
              }
            }
          }
        }
      }
    } else {
      functionCalls.push(...parsed.functionCalls);
      for (const call of parsed.functionCalls) {
        segments.push({ type: 'tool_call', value: call });
      }
      if (parsed.fallbackContent && !/^\s*[{[]/.test(parsed.fallbackContent)) {
        segments.push({ type: 'content', value: parsed.fallbackContent });
      }
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    const tail = text.slice(cursor);
    if (tail) {
      segments.push({ type: 'content', value: tail });
    }
  }

  if (!segments.length) return null;

  const content = segments
    .filter((segment) => segment.type === 'content')
    .map((segment) => segment.value)
    .join('');

  return { functionCalls, content, segments };
}

/**
 * Handles malformed tool call tags where the closing tag is missing the slash.
 * Pattern: `<tool_call>{json}<tool_call>` instead of `<tool_call>{json}</tool_call>`
 * Also handles truncated: `<tool_call>{json}` with no closing tag at all.
 */
function tryParseMalformedToolCallTags(
  text: string,
): ToolCallParseResult | null {
  // Match <tool_call> followed by content followed by:
  // - another <tool_call> (malformed close)
  // - end of string (truncated/missing close)
  const malformedPattern = /<tool_call>\s*([\s\S]*?)(?=<tool_call>|$)/gi;
  const functionCalls: Array<import('@google/genai').FunctionCall> = [];
  const segments: ToolCallParseSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = malformedPattern.exec(text)) !== null) {
    // Content before this tag
    const before = text.slice(cursor, match.index);
    if (before) {
      segments.push({ type: 'content', value: before });
    }

    const payload = (match[1] ?? '').trim();
    if (payload) {
      // Try to parse the JSON payload
      const result = createToolCallsFromJson(payload);
      if (result && result.functionCalls.length) {
        functionCalls.push(...result.functionCalls);
        for (const call of result.functionCalls) {
          segments.push({ type: 'tool_call', value: call });
        }
      } else {
        // Try bare JSON parsing
        const bare = tryParseBareFunctionJson(payload);
        if (bare.functionCalls.length) {
          functionCalls.push(...bare.functionCalls);
          for (const call of bare.functionCalls) {
            segments.push({ type: 'tool_call', value: call });
          }
        } else {
          // Try equals-sign name pattern (e.g. {"name="tool_name","arguments":{...}})
          const equalsCall = tryParseEqualsSignNameJson(payload);
          if (equalsCall) {
            functionCalls.push(equalsCall);
            segments.push({ type: 'tool_call', value: equalsCall });
          } else {
            // Try broken function= pattern (e.g. {"function=tool_name> <parameter=...>)
            const funcEqualsCall = tryParseBrokenFunctionEqualsPayload(payload);
            if (funcEqualsCall) {
              functionCalls.push(funcEqualsCall);
              segments.push({ type: 'tool_call', value: funcEqualsCall });
            } else {
              const nameColonCall = tryParseBrokenNameColonWithParams(payload);
              if (nameColonCall) {
                functionCalls.push(nameColonCall);
                segments.push({ type: 'tool_call', value: nameColonCall });
              }
            }
          }
        }
      }
    }

    cursor = match.index + match[0].length;
  }

  // Handle trailing content
  if (cursor < text.length) {
    const tail = text.slice(cursor);
    // Skip trailing malformed opening tags
    const cleanTail = tail.replace(/^<tool_call>\s*$/gi, '');
    if (cleanTail) {
      segments.push({ type: 'content', value: cleanTail });
    }
  }

  if (!functionCalls.length) return null;

  const content = segments
    .filter((s) => s.type === 'content')
    .map((s) => s.value)
    .join('');

  return { functionCalls, content, segments };
}

/**
 * Checks if content is a duplicate of tool call arguments.
 * Returns true if content exactly matches the arguments of any tool call.
 * This handles cases where some models (e.g., tgpt/gpt-oss-120b) return
 * content that is a copy of the tool call arguments JSON.
 */
export function isContentDuplicateOfToolCallArgs(
  content: string,
  toolCalls: Array<{ args: Record<string, unknown> }>,
): boolean {
  if (!content || !toolCalls.length) return false;

  const trimmed = content.trim();
  if (!trimmed) return false;

  // Try to parse content as JSON
  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(trimmed);
  } catch {
    return false; // Not JSON - not a duplicate
  }

  if (
    !parsedContent ||
    typeof parsedContent !== 'object' ||
    Array.isArray(parsedContent)
  ) {
    return false;
  }

  // Compare with args of each tool_call
  for (const toolCall of toolCalls) {
    if (deepEqual(parsedContent, toolCall.args)) {
      return true;
    }
  }

  return false;
}

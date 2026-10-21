/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallMarker } from './types.js';
import { OPEN_TAG, CLOSE_TAG } from './constants.js';

export function findToolCallMarkersOutsideStrings(
  text: string,
  openTag: string,
  closeTag: string,
): ToolCallMarker[] {
  const markers: ToolCallMarker[] = [];
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\') {
      escapeNext = true;
      continue;
    }

    if (!inDouble && !inBacktick && ch === "'") {
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }

    if (inSingle || inDouble || inBacktick) continue;

    if (text.startsWith(openTag, i)) {
      markers.push({ index: i, type: 'open' });
      i += openTag.length - 1;
      continue;
    }

    if (text.startsWith(closeTag, i)) {
      markers.push({ index: i, type: 'close' });
      i += closeTag.length - 1;
    }
  }

  return markers;
}

export function hasUnclosedToolCallTag(text: string): boolean {
  if (!text.includes(OPEN_TAG)) return false;
  const markers = findToolCallMarkersOutsideStrings(text, OPEN_TAG, CLOSE_TAG);
  if (!markers.length) return false;
  const stack: number[] = [];
  for (const marker of markers) {
    if (marker.type === 'open') {
      stack.push(marker.index);
    } else if (stack.length > 0) {
      stack.pop();
    }
  }
  return stack.length > 0;
}

export function splitOnUnclosedToolCallTag(
  text: string,
): { complete: string; remainder: string } | null {
  if (!text.includes(OPEN_TAG)) return null;
  const markers = findToolCallMarkersOutsideStrings(text, OPEN_TAG, CLOSE_TAG);
  if (!markers.length) return null;
  const stack: number[] = [];
  for (const marker of markers) {
    if (marker.type === 'open') {
      stack.push(marker.index);
    } else if (stack.length > 0) {
      stack.pop();
    }
  }
  if (!stack.length) return null;
  const splitIndex = stack[0];
  return {
    complete: text.slice(0, splitIndex),
    remainder: text.slice(splitIndex),
  };
}

export function hasUnclosedBracketToolCall(text: string): boolean {
  const lastOpen = text.lastIndexOf('[tool_call:');
  if (lastOpen === -1) return false;
  const lastClose = text.lastIndexOf(']');
  return lastClose === -1 || lastClose < lastOpen;
}

export function splitOnUnclosedBracketToolCall(
  text: string,
): { complete: string; remainder: string } | null {
  const lastOpen = text.lastIndexOf('[tool_call:');
  if (lastOpen === -1) return null;
  const lastClose = text.lastIndexOf(']');
  if (lastClose !== -1 && lastClose > lastOpen) return null;
  return {
    complete: text.slice(0, lastOpen),
    remainder: text.slice(lastOpen),
  };
}

/**
 * Check if text has an unclosed snake_case named tag like `<todo_write>` without
 * a matching `</todo_write>`. Only matches tags with underscores to avoid
 * false positives on HTML tags like <code>, <div>, etc.
 */
export function hasUnclosedNamedToolTag(text: string): boolean {
  const openRe = /<([a-z]\w*_\w+)>/gi;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(text)) !== null) {
    const tagName = match[1];
    const closeTag = `</${tagName}>`;
    if (!text.includes(closeTag)) return true;
  }
  return false;
}

/**
 * If there's an unclosed snake_case named tag at the end of text, split so
 * everything before is "complete" and the tag onward is "remainder".
 */
export function splitOnUnclosedNamedToolTag(
  text: string,
): { complete: string; remainder: string } | null {
  const openRe = /<([a-z]\w*_\w+)>/gi;
  let lastUnclosedIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(text)) !== null) {
    const tagName = match[1];
    const closeTag = `</${tagName}>`;
    if (!text.includes(closeTag)) {
      lastUnclosedIndex = match.index;
    }
  }
  if (lastUnclosedIndex === -1) return null;
  return {
    complete: text.slice(0, lastUnclosedIndex),
    remainder: text.slice(lastUnclosedIndex),
  };
}

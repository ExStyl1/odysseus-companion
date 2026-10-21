/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ValueContainer } from './types.js';

export function unescapeCommon(str: string): string {
  if (str.includes('\\n') || str.includes('\\t') || str.includes('\\r')) {
    try {
      const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return JSON.parse(`"${escaped}"`);
    } catch {
      return str
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');
    }
  }
  return str;
}

export function normalizeQuotes(str: string): string {
  return str.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

/**
 * Removes extra unmatched closing braces/brackets from JSON strings.
 * Handles cases where models emit duplicate closing characters like "}}" at the end.
 */
export function repairUnbalancedBraces(raw: string): string {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let end = raw.length;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        // Found the matching close for the top-level open brace;
        // everything after this is extra.
        end = i + 1;
        break;
      }
      if (depth < 0) {
        // Extra closing brace before we even opened — trim here.
        end = i;
        break;
      }
    }
  }

  return raw.slice(0, end);
}

export function stripCodeFence(raw: string): string {
  let s = raw.trim();
  if (!s.startsWith('```')) return s;
  const firstNl = s.indexOf('\n');
  if (firstNl === -1) return s;
  s = s.slice(firstNl + 1);
  const fence = s.lastIndexOf('```');
  if (fence !== -1) s = s.slice(0, fence);
  return s.trim();
}

export function extractSingleArgString(raw: string): string | null {
  const normalized = normalizeQuotes(raw).trim();
  if (!normalized) return null;
  const q = /^(['"`])([\s\S]*?)\1\s*$/.exec(normalized);
  if (q) {
    return unescapeCommon((q[2] ?? '').trim());
  }
  return unescapeCommon(normalized);
}

export function createShortDescription(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'Task';
  const words = trimmed.split(/\s+/).slice(0, 5).join(' ');
  return words.length > 0 ? words : 'Task';
}

export function sanitizeToolCallName(rawName: string): string | null {
  const trimmed = rawName.trim();
  if (!trimmed) return null;

  const validName = /^([A-Za-z0-9_][A-Za-z0-9_.:/-]*)/.exec(trimmed);
  return validName?.[1] ?? null;
}

export function unwrapValueContainers(
  obj: unknown,
): Record<string, unknown> | unknown[] | unknown {
  if (obj && typeof obj === 'object') {
    if ('type' in obj && 'value' in obj) {
      return unwrapValueContainers((obj as ValueContainer).value);
    }
    if (Array.isArray(obj)) {
      return obj.map(unwrapValueContainers);
    }
    if (obj instanceof Object) {
      return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => [
          key,
          unwrapValueContainers(value),
        ]),
      );
    }
  }
  return obj;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;

  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }

  return true;
}

export function extractJsonObjectAfterKey(
  raw: string,
  key: string,
): string | null {
  const keyIdx = raw.indexOf(`"${key}"`);
  if (keyIdx === -1) return null;

  const braceStart = raw.indexOf('{', keyIdx);
  if (braceStart === -1) return null;

  let depth = 0;
  for (let i = braceStart; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;

    if (depth === 0) {
      return raw.slice(braceStart, i + 1);
    }
  }
  return null;
}

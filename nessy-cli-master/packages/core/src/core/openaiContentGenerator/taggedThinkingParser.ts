/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('TAGGED_THINKING_PARSER');

// Parser uses a binary mode toggle rather than a tag stack, so
// <think>content</thinking> is valid and cross-matching is intentional.
// MiniMax only uses one tag type per response in practice.
const OPEN_TAGS = ['<think>', '<thinking>'] as const;
const CLOSE_TAGS = ['</think>', '</thinking>'] as const;

/** Longest tag length across all open/close variants ('</thinking>' = 11). */
const MAX_TAG_LENGTH = Math.max(
  ...OPEN_TAGS.map((t) => t.length),
  ...CLOSE_TAGS.map((t) => t.length),
);

type ParserMode = 'text' | 'thought';

function appendPart(parts: Part[], text: string, mode: ParserMode): void {
  if (!text) return;
  parts.push(mode === 'thought' ? { text, thought: true } : { text });
}

/**
 * Check whether the suffix starting at `offset` in the pre-computed
 * lowercase buffer is a prefix of any tag. The caller MUST pass a
 * fully-lowercased buffer to avoid repeated `toLowerCase()` allocations.
 */
function isPrefixOfAnyTag(
  lower: string,
  offset: number,
  tags: readonly string[],
): boolean {
  const remainingLen = lower.length - offset;
  if (remainingLen <= 0) return false;
  // If the remaining text is longer than the longest tag it cannot be a
  // prefix of any tag, so we can bail early without slicing.
  if (remainingLen > MAX_TAG_LENGTH) return false;
  // Slice is bounded to MAX_TAG_LENGTH (≤ 11 chars) → O(1).
  return tags.some((tag) =>
    tag.startsWith(lower.slice(offset, offset + remainingLen)),
  );
}

/**
 * [nessy-fork] streaming-dedup-and-parser-fixes
 * Tags wrapped in adjacent markdown backticks are literal text (`<think>` or
 * `</think>` as code spans), not real reasoning markers. The parser must skip
 * them so the model can describe its own tags in prose without triggering
 * thought-mode switching.
 */
function isBacktickQuoted(
  text: string,
  tagStart: number,
  tagEnd: number,
): boolean {
  return text[tagStart - 1] === '`' && text[tagEnd] === '`';
}

/**
 * Find a tag that matches the text at `offset` in the pre-computed
 * lowercase buffer. Returns the matched tag string or undefined.
 */
function findMatchingTag(
  lower: string,
  offset: number,
  tags: readonly string[],
): string | undefined {
  const tag = tags.find((t) => lower.startsWith(t, offset));
  if (tag && isBacktickQuoted(lower, offset, offset + tag.length)) {
    return undefined;
  }
  return tag;
}

function findEarliestMatchingTag(
  lower: string,
  tags: readonly string[],
): { index: number; tag: string } | undefined {
  let earliest: { index: number; tag: string } | undefined;

  for (const tag of tags) {
    let from = 0;
    while (from < lower.length) {
      const index = lower.indexOf(tag, from);
      if (index === -1) break;
      if (!isBacktickQuoted(lower, index, index + tag.length)) {
        if (!earliest || index < earliest.index) {
          earliest = { index, tag };
        }
        break;
      }
      from = index + 1;
    }
  }

  return earliest;
}

/**
 * Find the offset of the first tag prefix in the string.
 * Returns the index where a partial tag begins (e.g. '<thi' from '<thinking>').
 * Used to detect incomplete tag prefixes that should be buffered for the next chunk.
 */
function findTagPrefixOffset(lower: string): number {
  const allTags = [...OPEN_TAGS, ...CLOSE_TAGS];
  let earliestOffset = lower.length;

  for (const tag of allTags) {
    for (let i = 0; i < lower.length; i++) {
      const remaining = lower.slice(i);
      if (tag.startsWith(remaining) && remaining.length > 0) {
        if (i < earliestOffset) {
          earliestOffset = i;
        }
        break;
      }
    }
  }

  return earliestOffset < lower.length ? earliestOffset : -1;
}

export class TaggedThinkingParser {
  private mode: ParserMode = 'text';
  private phase: 'detecting' | 'normal' = 'detecting';
  private buffer = '';

  parse(chunk: string, final = false): Part[] {
    if (this.phase === 'normal') {
      return this.parseNormal(chunk, final);
    }

    this.buffer += chunk;
    const lower = this.buffer.toLowerCase();

    const openMatch = findEarliestMatchingTag(lower, OPEN_TAGS);
    if (openMatch) {
      const accumulated = this.buffer;
      this.buffer = '';
      this.phase = 'normal';
      return this.parseNormal(accumulated, final);
    }

    const closeMatch = findEarliestMatchingTag(lower, CLOSE_TAGS);
    if (closeMatch) {
      const thought = this.buffer.slice(0, closeMatch.index);
      const rest = this.buffer.slice(closeMatch.index + closeMatch.tag.length);
      const parts: Part[] = [];
      this.buffer = '';
      this.phase = 'normal';
      appendPart(parts, thought, 'thought');
      parts.push(...this.parseNormal(rest, final));
      return parts;
    }

    if (final) {
      const accumulated = this.buffer;
      this.buffer = '';
      this.phase = 'normal';
      return this.parseNormal(accumulated, final);
    }

    // Non-final chunk with incomplete tag prefix: emit text before the
    // partial prefix and buffer only the prefix itself for the next chunk.
    const prefixOffset = findTagPrefixOffset(lower);
    if (prefixOffset > 0) {
      const textBefore = this.buffer.slice(0, prefixOffset);
      const prefix = this.buffer.slice(prefixOffset);
      this.buffer = prefix;
      const parts: Part[] = [];
      appendPart(parts, textBefore, this.mode);
      return parts;
    }

    return [];
  }

  private parseNormal(chunk: string, final = false): Part[] {
    this.buffer += chunk;
    // Pre-compute a lowercase copy once per call to avoid repeated
    // O(N) slice+toLowerCase allocations inside the character loop.
    const lower = this.buffer.toLowerCase();

    const parts: Part[] = [];
    let segment = '';
    let index = 0;

    while (index < this.buffer.length) {
      const activeTags = this.mode === 'text' ? OPEN_TAGS : CLOSE_TAGS;
      const matchedTag = findMatchingTag(lower, index, activeTags);

      if (matchedTag) {
        debugLogger.debug(
          `taggedThinking: detected tag "${matchedTag}" at offset ${index}`,
        );
        appendPart(parts, segment, this.mode);
        segment = '';
        this.mode = this.mode === 'text' ? 'thought' : 'text';
        index += matchedTag.length;
        continue;
      }

      if (!final && isPrefixOfAnyTag(lower, index, activeTags)) {
        break;
      }

      segment += this.buffer[index];
      index += 1;
    }

    if (index < this.buffer.length) {
      appendPart(parts, segment, this.mode);
      this.buffer = this.buffer.slice(index);
      debugLogger.debug(
        `taggedThinking: emitted ${parts.length} part(s), buffered ${this.buffer.length} char(s)`,
      );
      return parts;
    }

    this.buffer = '';
    // Safety net: log when flushing an unclosed thought buffer
    // to make this silent data-loss scenario observable.
    if (this.mode === 'thought' && segment) {
      debugLogger.warn(
        `taggedThinking: flushing ${segment.length} chars of unclosed thought on stream end`,
      );
    }
    appendPart(parts, segment, this.mode);
    debugLogger.debug(
      `taggedThinking: emitted ${parts.length} part(s), flush complete`,
    );
    return parts;
  }
}

export function parseTaggedThinkingText(
  text: string,
  includeThought = false,
): Part[] {
  if (!includeThought) {
    // When thought parts should not be included, return raw text as-is
    return [{ text }];
  }
  return new TaggedThinkingParser().parse(text, true);
}

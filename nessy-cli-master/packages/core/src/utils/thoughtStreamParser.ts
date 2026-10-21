/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type ThoughtStreamParseResult = {
  thoughts: string[];
  visibleText: string;
};

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export class ThoughtStreamParser {
  private buffer = '';
  private phase: 'detecting' | 'normal' = 'detecting';

  reset(): void {
    this.buffer = '';
    this.phase = 'detecting';
  }

  parseChunk(text: string): ThoughtStreamParseResult {
    if (!text) {
      return { thoughts: [], visibleText: '' };
    }

    if (this.phase === 'normal') {
      return this.parseNormal(text);
    }

    // detecting phase: accumulate and look for tags
    this.buffer += text;

    // Check for <think> — switch to normal mode with standard logic
    if (this.buffer.includes(OPEN_TAG)) {
      const accumulated = this.buffer;
      this.buffer = '';
      this.phase = 'normal';
      return this.parseNormal(accumulated);
    }

    // Check for </think> without <think> — fallback: content before is thought
    const closeIdx = this.buffer.indexOf(CLOSE_TAG);
    if (closeIdx !== -1) {
      const thought = this.buffer.slice(0, closeIdx);
      const rest = this.buffer.slice(closeIdx + CLOSE_TAG.length);
      this.buffer = '';
      this.phase = 'normal';
      const thoughts = thought.length > 0 ? [thought] : [];
      return { thoughts, visibleText: rest };
    }

    // [nessy-fork] streaming-dedup-and-parser-fixes
    // No tags yet — keep buffering. Earlier we flushed on \n\n as a
    // "this is plain text" heuristic, but real orphan thoughts can contain
    // paragraph breaks before </think>, so the heuristic stripped the close
    // tag from the visible output. Wait for an explicit tag or flush().
    return { thoughts: [], visibleText: '' };
  }

  private parseNormal(text: string): ThoughtStreamParseResult {
    this.buffer += text;

    const thoughts: string[] = [];
    let visibleText = '';
    let cursor = 0;

    while (true) {
      const start = this.buffer.indexOf(OPEN_TAG, cursor);
      if (start === -1) {
        visibleText += this.buffer.slice(cursor);
        this.buffer = '';
        break;
      }

      const end = this.buffer.indexOf(CLOSE_TAG, start + OPEN_TAG.length);
      if (end === -1) {
        visibleText += this.buffer.slice(cursor, start);
        this.buffer = this.buffer.slice(start);
        break;
      }

      visibleText += this.buffer.slice(cursor, start);
      const rawThought = this.buffer.slice(start + OPEN_TAG.length, end);
      thoughts.push(rawThought);
      cursor = end + CLOSE_TAG.length;
    }

    return { thoughts, visibleText };
  }

  flush(): ThoughtStreamParseResult {
    if (!this.buffer) {
      return { thoughts: [], visibleText: '' };
    }

    const visibleText = this.buffer;
    this.buffer = '';
    return { thoughts: [], visibleText };
  }
}

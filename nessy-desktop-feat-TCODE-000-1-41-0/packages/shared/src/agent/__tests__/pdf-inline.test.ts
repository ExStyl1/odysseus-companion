/**
 * UB2.11 (B2 S-04) — the PDF inline gate, arms copied+adapted from
 * craft-agents-oss v0.15.1 `pdf-inline.test.ts` (Apache-2.0), plus the NESSY
 * route arm: a translated route (the `claude-gateway` loopback adapter drops a
 * `document` block to `[document…]` text) inlines NOTHING.
 */
import { describe, expect, it } from 'bun:test';
import { MAX_INLINE_PDF_BYTES, largePdfNote, shouldInlinePdf, shouldInlinePdfForRoute } from '../pdf-inline.ts';

const MB = 1024 * 1024;

describe('shouldInlinePdf', () => {
  it('POSITIVE — a 2 MB PDF with base64 goes inline (a direct Anthropic card keeps it)', () => {
    expect(shouldInlinePdf({ size: 2 * MB, base64: 'aGVsbG8=' })).toBe(true);
    expect(shouldInlinePdfForRoute({ size: 2 * MB, base64: 'aGVsbG8=' }, { nativeAnthropicMessages: true })).toBe(true);
  });

  it('NEGATIVE — a 59.7 MB PDF never goes inline, whatever the route', () => {
    const big = { size: Math.round(59.7 * MB), base64: 'aGVsbG8=' };
    expect(shouldInlinePdf(big)).toBe(false);
    expect(shouldInlinePdfForRoute(big, { nativeAnthropicMessages: true })).toBe(false);
    expect(shouldInlinePdfForRoute(big, { nativeAnthropicMessages: false })).toBe(false);
  });

  it('the boundary sits at MAX_INLINE_PDF_BYTES (at it: inline; one byte over: path)', () => {
    expect(shouldInlinePdf({ size: MAX_INLINE_PDF_BYTES, base64: 'aGVsbG8=' })).toBe(true);
    expect(shouldInlinePdf({ size: MAX_INLINE_PDF_BYTES + 1, base64: 'aGVsbG8=' })).toBe(false);
  });

  it('a PDF without base64 cannot go inline at all', () => {
    expect(shouldInlinePdf({ size: 100 })).toBe(false);
  });
});

describe('shouldInlinePdfForRoute (the NESSY gateway arm)', () => {
  it('on a TRANSLATED route (claude-gateway) even a 2 MB PDF goes by path', () => {
    expect(shouldInlinePdfForRoute({ size: 2 * MB, base64: 'aGVsbG8=' }, { nativeAnthropicMessages: false })).toBe(false);
  });
});

describe('largePdfNote', () => {
  it('POSITIVE — a 59.7 MB PDF yields the stored-path note naming its size', () => {
    const note = largePdfNote({ name: 'big report.pdf', size: Math.round(59.7 * MB) });
    expect(note).toContain('big report.pdf');
    // The note reports DECIMAL megabytes (raw/1e6): 59.7 MiB is 62.6 MB.
    expect(note).toContain('62.6 MB');
    expect(note).toContain('Read it from the stored path above');
    expect(note).toContain('pages parameter');
  });
});

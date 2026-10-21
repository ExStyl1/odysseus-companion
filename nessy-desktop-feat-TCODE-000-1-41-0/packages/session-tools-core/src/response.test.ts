/**
 * P3.11 review (I2) — the STRIP branch of `withoutEmptyStructuredContent()`.
 *
 * The codex fidelity rows in `session-mcp-server` drive results that all come
 * out of factories which no longer emit a payload at all, so every one of them
 * leaves the guard through its IDENTITY branch: neutering the guard's body
 * leaves that suite green. The branch the guard actually exists for is the one
 * these rows exercise — a result arriving WITH an empty or null payload, which
 * is what a context-bound handler (and any tool added later) still produces.
 *
 * The rule being mirrored is codex's own, quoted verbatim in `response.ts`:
 * `CallToolResult::as_function_call_output_payload` tests `is_null()`, not "is
 * empty" (`codex-rs/protocol/src/models.rs` at the tag
 * `packages/codex-protocol/manifest.json` pins), so a present-but-empty payload
 * replaces the whole reply text with the two characters `{}`.
 */
import { describe, expect, it } from 'bun:test';
import { errorResponse, withoutEmptyStructuredContent } from './response.ts';

describe('withoutEmptyStructuredContent — the strip branch', () => {
  it('drops an empty object: the key is ABSENT afterwards, not empty', () => {
    const result = withoutEmptyStructuredContent({
      ...errorResponse('Monitor command watch was denied'),
      structuredContent: {},
    });

    // `in`, not `=== undefined`: codex reads the field's PRESENCE, so a key
    // left behind holding `{}` would still win over the text.
    expect('structuredContent' in result).toBe(false);
    expect(result.content).toEqual([
      { type: 'text', text: '[ERROR] Monitor command watch was denied' },
    ]);
    expect(result.isError).toBe(true);
  });

  it('drops a null payload', () => {
    const result = withoutEmptyStructuredContent({
      content: [{ type: 'text', text: 'done' }],
      structuredContent: null,
      isError: false,
    });

    expect('structuredContent' in result).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(result.isError).toBe(false);
  });

  it('drops an explicitly-undefined payload — a declared key is a present key', () => {
    const result = withoutEmptyStructuredContent({
      content: [{ type: 'text', text: 'done' }],
      structuredContent: undefined,
    });

    expect('structuredContent' in result).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('passes a real record through by identity, untouched', () => {
    const input = {
      content: [{ type: 'text', text: 'Scheduled task ab12cd34' }],
      structuredContent: { task: { id: 'x' } },
      isError: false,
    };

    const result = withoutEmptyStructuredContent(input);

    // Identity, not a copy: this is the path T6 measured working, and it stays
    // byte-identical on the wire.
    expect(result).toBe(input);
    expect(result.structuredContent).toEqual({ task: { id: 'x' } });
    expect(result.isError).toBe(false);
  });

  it('returns a result that never declared the field by identity', () => {
    const input = errorResponse('Goal is unavailable for this session.');

    // The dispatcher this guards returns a UNION; a member without the field is
    // exactly the shape that must not be rebuilt.
    expect(withoutEmptyStructuredContent(input)).toBe(input);
  });
});

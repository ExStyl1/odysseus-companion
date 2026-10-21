import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

/**
 * A Pi tool result's `content` is `(TextContent | ImageContent)[]` — a
 * discriminated union, so `content[0].text` does not typecheck. Tests written
 * before this package's test files were in the typecheck program reached for
 * `.text` directly; 27 such sites existed when the exclusion glob was removed
 * (P3.165).
 *
 * The obvious repairs are both wrong:
 *
 * - `as TextContent` silences the checker and keeps a genuinely-image part
 *   flowing into the assertion as `undefined`.
 * - `part.type === 'text' ? part.text : ''` — the ternary this package already
 *   uses where a whole content array is JOINED — substitutes the empty string,
 *   which makes a NEGATIVE assertion (`expect(...).not.toContain(x)`) pass
 *   having proved nothing. Two of the 27 sites are exactly that shape.
 *
 * So this narrows LOUDLY: a missing part or a non-text part throws, naming what
 * it found. Use it where a test indexes a single part it expects to be text.
 * Where a test folds every part into one string, the existing filter/join
 * pattern is still right — an image part contributes nothing to a join by
 * design.
 */
export function textPartAt(
  content: readonly (TextContent | ImageContent)[] | undefined,
  index = 0,
): string {
  if (content === undefined) {
    throw new Error(`expected tool result content, got undefined (index ${index})`);
  }
  const part = content[index];
  if (part === undefined) {
    throw new Error(
      `expected a content part at index ${index}, but the result has ${content.length}`,
    );
  }
  if (part.type !== 'text') {
    throw new Error(`expected content[${index}] to be text, but it is '${part.type}'`);
  }
  return part.text;
}

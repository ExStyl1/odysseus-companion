import { describe, expect, it } from 'bun:test';
import {
  SearchReplaceDiffError,
  buildSearchReplaceFormatReminder,
  parseSearchReplaceDiff,
} from '../search-replace-diff.ts';

function block(search: string, replace: string): string {
  return `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
}

function errorOf(diff: string): SearchReplaceDiffError {
  try {
    parseSearchReplaceDiff(diff);
  } catch (error) {
    if (error instanceof SearchReplaceDiffError) return error;
    throw error;
  }
  throw new Error(`Expected a SearchReplaceDiffError for: ${JSON.stringify(diff)}`);
}

function messageOf(diff: string): string {
  return errorOf(diff).message;
}

describe('parseSearchReplaceDiff', () => {
  it('parses a single block into one edit', () => {
    expect(parseSearchReplaceDiff(block('const x = 1;', 'const x = 2;'))).toEqual([
      { oldText: 'const x = 1;', newText: 'const x = 2;' },
    ]);
  });

  it('keeps multi-line block content verbatim, including interior blank lines', () => {
    const edits = parseSearchReplaceDiff(block('line1\n\nline2', 'new1\nnew2\nnew3'));

    expect(edits).toHaveLength(1);
    expect(edits[0]!.oldText).toBe('line1\n\nline2');
    expect(edits[0]!.newText).toBe('new1\nnew2\nnew3');
  });

  it('returns multiple blocks in the order they appear', () => {
    const diff = [block('aaa', 'AAA'), block('bbb', 'BBB'), block('ccc', 'CCC')].join('\n');

    expect(parseSearchReplaceDiff(diff)).toEqual([
      { oldText: 'aaa', newText: 'AAA' },
      { oldText: 'bbb', newText: 'BBB' },
      { oldText: 'ccc', newText: 'CCC' },
    ]);
  });

  it('allows blank lines between blocks and a trailing newline', () => {
    const diff = `${block('a', 'A')}\n\n\n${block('b', 'B')}\n`;

    expect(parseSearchReplaceDiff(diff)).toEqual([
      { oldText: 'a', newText: 'A' },
      { oldText: 'b', newText: 'B' },
    ]);
  });

  it('reads an empty REPLACE section as a deletion', () => {
    expect(parseSearchReplaceDiff('<<<<<<< SEARCH\ndead code\n=======\n>>>>>>> REPLACE')).toEqual([
      { oldText: 'dead code', newText: '' },
    ]);
  });

  it('tolerates CRLF marker lines and preserves CRLF inside the block content', () => {
    const diff = '<<<<<<< SEARCH\r\nold1\r\nold2\r\n=======\r\nnew1\r\n>>>>>>> REPLACE\r\n';

    expect(parseSearchReplaceDiff(diff)).toEqual([
      { oldText: 'old1\r\nold2', newText: 'new1' },
    ]);
  });

  it('tolerates trailing whitespace on marker lines', () => {
    expect(parseSearchReplaceDiff('<<<<<<< SEARCH  \nfoo\n=======\t\nbar\n>>>>>>> REPLACE ')).toEqual([
      { oldText: 'foo', newText: 'bar' },
    ]);
  });

  it('does not treat a marker-looking line inside content as a marker when indented', () => {
    const edits = parseSearchReplaceDiff(block('  <<<<<<< SEARCH', '  ok'));

    expect(edits).toEqual([{ oldText: '  <<<<<<< SEARCH', newText: '  ok' }]);
  });

  it('rejects prose before the first block', () => {
    expect(() => parseSearchReplaceDiff(`Here is the change:\n${block('a', 'b')}`))
      .toThrow(SearchReplaceDiffError);
  });

  it('rejects prose after the last block', () => {
    expect(() => parseSearchReplaceDiff(`${block('a', 'b')}\nThat should do it.`))
      .toThrow(/outside/i);
  });

  it('rejects a diff wrapped in markdown fences', () => {
    expect(() => parseSearchReplaceDiff('```\n' + block('a', 'b') + '\n```'))
      .toThrow(SearchReplaceDiffError);
  });

  it('rejects an unterminated SEARCH section', () => {
    expect(() => parseSearchReplaceDiff('<<<<<<< SEARCH\nfoo\n')).toThrow(/unterminated/i);
  });

  it('rejects an unterminated REPLACE section', () => {
    expect(() => parseSearchReplaceDiff('<<<<<<< SEARCH\nfoo\n=======\nbar\n')).toThrow(/unterminated/i);
  });

  it('rejects a nested SEARCH marker before the separator', () => {
    expect(() => parseSearchReplaceDiff('<<<<<<< SEARCH\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE'))
      .toThrow(SearchReplaceDiffError);
  });

  it('rejects a second separator inside one block', () => {
    expect(() => parseSearchReplaceDiff('<<<<<<< SEARCH\nfoo\n=======\nbar\n=======\nbaz\n>>>>>>> REPLACE'))
      .toThrow(SearchReplaceDiffError);
  });

  it('rejects a REPLACE terminator without an open block', () => {
    expect(() => parseSearchReplaceDiff('>>>>>>> REPLACE')).toThrow(SearchReplaceDiffError);
  });

  it('rejects a diff with no blocks at all', () => {
    expect(() => parseSearchReplaceDiff('not a diff')).toThrow(SearchReplaceDiffError);
    expect(() => parseSearchReplaceDiff('')).toThrow(/no .*blocks/i);
    expect(() => parseSearchReplaceDiff('   \n\n')).toThrow(/no .*blocks/i);
  });

  it('rejects an empty SEARCH section instead of silently anchoring at offset 0', () => {
    expect(() => parseSearchReplaceDiff('<<<<<<< SEARCH\n\n=======\nnew\n>>>>>>> REPLACE'))
      .toThrow(/empty/i);
    expect(() => parseSearchReplaceDiff('<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE'))
      .toThrow(/empty/i);
  });

  it('carries the format reminder in the error message so the model can recover', () => {
    const message = messageOf('not a diff');

    expect(message).toContain('replace_in_file failed');
    expect(message).toContain('<<<<<<< SEARCH');
    expect(message).toContain('=======');
    expect(message).toContain('>>>>>>> REPLACE');
    expect(messageOf('')).toBe(
      buildSearchReplaceFormatReminder('No valid SEARCH/REPLACE blocks found in diff'),
    );
  });

  it('names the offending line in the details, not just the generic reminder', () => {
    const error = errorOf('That should do it.');

    expect(error.details).toBe('Unexpected content outside a SEARCH/REPLACE block: "That should do it."');
  });

  it('rejects a non-string diff at the boundary', () => {
    expect(() => parseSearchReplaceDiff(undefined as unknown as string)).toThrow(SearchReplaceDiffError);
  });
});

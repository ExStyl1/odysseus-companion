/**
 * R56 · f102 f103 f166 — the auto-memory index write contract.
 *
 * `memory.md:386` — "After Claude writes to `MEMORY.md`, Claude Code measures
 * the file against the 200-line and 25KB read limits. If the file is near a
 * limit, Claude Code reminds Claude to shorten it … If the file is over a limit,
 * the write still succeeds, but Claude Code returns an error telling Claude to
 * rewrite the index."
 * `memory.md:388` / `errors.md:1549` — "YAML frontmatter and block-level HTML
 * comments are stripped before the index is loaded, so they're excluded from the
 * measurement."
 * `memory.md:398` — "Any file that has frontmatter gets the field the next time
 * Claude writes it, including files created on earlier versions; Claude Code
 * never adds frontmatter to a file that has none."
 */

import { describe, expect, it } from 'bun:test';
import {
  measureMemoryIndex,
  memoryIndexLoadedContent,
  memoryIndexWriteNotice,
  stampMemoryModified,
  MEMORY_LOAD_BYTE_LIMIT,
  MEMORY_LOAD_LINE_LIMIT,
} from './memory-index.ts';

const ISO_8601 = /^modified: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('stampMemoryModified', () => {
  it('adds the field to a file that HAS frontmatter, leaving every other byte alone', () => {
    const stamped = stampMemoryModified('---\ntitle: Notes\nowner: me\n---\n\n# Memory\n\n- a fact\n');
    const lines = stamped.split('\n');

    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe('title: Notes');
    expect(lines[2]).toBe('owner: me');
    expect(lines[3]).toMatch(ISO_8601);
    expect(lines[4]).toBe('---');
    // The body after the closing fence is untouched, trailing newline included.
    expect(stamped.endsWith('---\n\n# Memory\n\n- a fact\n')).toBe(true);
  });

  it('REPLACES an existing stamp instead of appending a second one', () => {
    const once = stampMemoryModified('---\nmodified: 2020-01-01T00:00:00.000Z\ntitle: Notes\n---\nbody\n');
    const twice = stampMemoryModified(once);

    expect(twice.match(/^modified:/gm)).toHaveLength(1);
    expect(twice).not.toContain('2020-01-01');
    expect(twice).toContain('title: Notes');
  });

  it('preserves a CRLF file\'s line endings', () => {
    const stamped = stampMemoryModified('---\r\ntitle: Notes\r\n---\r\n\r\n- a fact\r\n');

    expect(stamped).toContain('\r\n');
    expect(stamped.split('\r\n')[2]).toMatch(ISO_8601);
    // No bare LF anywhere: a CRLF file must not be silently rewritten to LF.
    expect(/[^\r]\n/.test(stamped)).toBe(false);
  });

  // `memory.md:398` — "Claude Code never adds frontmatter to a file that has
  // none." The unclosed-fence case is the same rule: an opening `---` with no
  // closing one is a horizontal rule in Markdown, not frontmatter.
  const untouched: Array<{ name: string; content: string }> = [
    { name: 'a file with no frontmatter', content: '# Memory\n\n- a fact\n' },
    { name: 'a file whose `---` is never closed', content: '---\ntitle: Notes\n\n# Memory\n' },
    { name: 'an empty file', content: '' },
  ];
  for (const testCase of untouched) {
    it(`leaves ${testCase.name} byte-identical`, () => {
      expect(stampMemoryModified(testCase.content)).toBe(testCase.content);
    });
  }
});

describe('measureMemoryIndex', () => {
  it('excludes frontmatter and block-level comments but still counts the inline auto-marker', () => {
    const raw = [
      '---',
      'title: Notes',
      'modified: 2026-08-07T00:00:00.000Z',
      '---',
      '<!--',
      'maintainer note nobody loads',
      '-->',
      '# Memory',
      '',
      '- a fact <!-- nessy:auto:2026-08-07 -->',
    ].join('\n');

    const measured = measureMemoryIndex(raw);

    // Only `# Memory`, the blank line and the entry survive to be counted.
    expect(measured.lines).toBe(3);
    expect(measured.bytes).toBe(Buffer.byteLength('# Memory\n\n- a fact <!-- nessy:auto:2026-08-07 -->', 'utf-8'));
    // The trailing marker is inline, not block-level, so it is charged.
    expect(measured.bytes).toBeGreaterThan(Buffer.byteLength('# Memory\n\n- a fact', 'utf-8'));
  });

  // The invariant the whole module exists for: the write check and the load cap
  // count the SAME bytes. Asserted against ONE fixture in both directions.
  it('counts exactly what the load cap keeps', () => {
    const header = '---\ntitle: Notes\n---\n<!--\nnote\n-->\n';
    const entry = (index: number) => `- entry ${index + 1}`;

    const under = header + Array.from({ length: 150 }, (_, i) => entry(i)).join('\n');
    const underLoaded = memoryIndexLoadedContent(under);
    // Nothing dropped, so the measurement IS the loaded content's own size.
    expect(measureMemoryIndex(under)).toEqual({
      lines: 150,
      bytes: Buffer.byteLength(underLoaded, 'utf-8'),
    });
    expect(underLoaded.split('\n')).toHaveLength(150);

    const over = header + Array.from({ length: 210 }, (_, i) => entry(i)).join('\n');
    const overLoaded = memoryIndexLoadedContent(over);
    expect(measureMemoryIndex(over).lines).toBe(210);
    // What survives the cap measures exactly at the limit — same split, same
    // join, same byte accounting on both sides.
    expect(measureMemoryIndex(overLoaded)).toEqual({
      lines: MEMORY_LOAD_LINE_LIMIT,
      bytes: Buffer.byteLength(overLoaded, 'utf-8'),
    });
    expect(overLoaded).not.toContain('- entry 201');
  });
});

describe('memoryIndexWriteNotice', () => {
  it('returns the documented error over the line limit, saying the write succeeded', () => {
    const notice = memoryIndexWriteNotice('/p/MEMORY.md', { lines: 214, bytes: 4_000 });

    expect(notice.level).toBe('over');
    // `errors.md:1546`, adapted: the leading `Error: ` is supplied by
    // `errorResponse`'s `[ERROR] ` prefix, and "topic files" becomes the `@path`
    // import this fork actually has.
    expect(notice.message).toContain('this write left the memory index at /p/MEMORY.md at 214 lines');
    expect(notice.message).toContain('over its 200-line read limit');
    expect(notice.message).toContain('The write succeeded');
    expect(notice.message).toContain('silently dropped each time the index is loaded');
    expect(notice.message).toContain('Rewrite it to under 140 lines now');
    expect(notice.message).toContain('`@path` import');
  });

  it('returns the byte branch when only the byte limit is crossed', () => {
    const notice = memoryIndexWriteNotice('/p/MEMORY.md', { lines: 20, bytes: MEMORY_LOAD_BYTE_LIMIT + 1 });

    expect(notice.level).toBe('over');
    expect(notice.message).toContain('25KB) read limit');
    expect(notice.message).toContain('The write succeeded');
  });

  it('returns the milder reminder near a limit and nothing at all below it', () => {
    // `errors.md:1553` — near a limit without crossing it, "a milder reminder to
    // compact the index instead of this error".
    const near = memoryIndexWriteNotice('/p/MEMORY.md', { lines: 182, bytes: 4_000 });
    expect(near.level).toBe('near');
    expect(near.message).toContain('near its read limit');
    expect(near.message).toContain('182 of 200 lines');
    expect(near.message).not.toContain('Rewrite it');

    expect(memoryIndexWriteNotice('/p/MEMORY.md', { lines: 30, bytes: 900 })).toEqual({
      level: 'ok',
      message: '',
    });
  });
});

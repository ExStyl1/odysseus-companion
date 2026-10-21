/**
 * P6.231(b) — the search fallback branch is bounded and fenced.
 *
 * The citation branch bounds every snippet at 280 characters and the tool's own
 * schema caps `count` at 10, so a citation-shaped answer costs the turn at most
 * 2 800 characters of provider text. The fallback branch — taken whenever the
 * provider answers in prose with no citations — put the provider's ENTIRE
 * output text into one result's `description` with no bound and no marking. The
 * cheaper-looking branch was the unbounded one, and nothing downstream could
 * tell the two apart, because both were titled "Search results for …".
 */
import { describe, expect, it } from 'bun:test';
import {
  SEARCH_CITATION_FENCE_SOURCE,
  SEARCH_FALLBACK_FENCE_SOURCE,
  SEARCH_FALLBACK_MAX_CHARS,
  parseResponsesApiResults,
} from './responses-api-parser.ts';

function prose(text: string) {
  return { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] };
}

function cited(text: string, start: number, end: number) {
  return {
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text,
        annotations: [{ type: 'url_citation', url: 'https://example.com/a', title: 'A', start_index: start, end_index: end }],
      }],
    }],
  };
}

describe('P6.231(b) · the fallback branch', () => {
  it('fences the provider text as untrusted, with the same wrapper the transcript uses', () => {
    const [result] = parseResponsesApiResults(prose('the provider wrote this'), 'nessy', 5);

    expect(result!.description).toBe(
      `<untrusted source="${SEARCH_FALLBACK_FENCE_SOURCE}">\nthe provider wrote this\n</untrusted>`,
    );
  });

  it('says in the TITLE that nobody summarized it', () => {
    const [result] = parseResponsesApiResults(prose('anything'), 'nessy', 5);
    expect(result!.title).toBe('Unsummarized provider text for "nessy"');
    // Sharing the citation branch's title is what made the two indistinguishable.
    expect(result!.title).not.toContain('Search results for');
  });

  it('BOUNDS it, and the bound is the citation branch\'s own worst case', () => {
    // 10 (the schema's `count` maximum) x 280 (the per-citation snippet cap).
    expect(SEARCH_FALLBACK_MAX_CHARS).toBe(2800);

    const [result] = parseResponsesApiResults(prose('x'.repeat(50_000)), 'nessy', 5);
    const body = result!.description;

    expect(body).toContain('…');
    // The fence adds its own two lines; what is bounded is the TEXT inside it.
    const inner = body.split('\n')[1]!;
    expect(inner.length).toBe(SEARCH_FALLBACK_MAX_CHARS);
    expect(body.length).toBeLessThan(3000);
  });

  it('leaves text under the bound byte-identical, ellipsis included', () => {
    const exact = 'y'.repeat(SEARCH_FALLBACK_MAX_CHARS);
    const [result] = parseResponsesApiResults(prose(exact), 'nessy', 5);
    expect(result!.description.split('\n')[1]).toBe(exact);
    expect(result!.description).not.toContain('…');
  });

  /**
   * AMENDED BY P6.609, with the reason, because the assertion it replaces was
   * true and is now wrong.
   *
   * It read "the citation branch is unchanged — bounded at 280, titled and
   * unfenced", and its docblock said the row scoped the fence to the fallback so
   * that "the change above is satisfied by fencing every search result, which
   * would rewrite the shape of every ordinary search answer". P6.609 is the row
   * that decided the citation snippets ARE third-party text and take the fence
   * too — the narrowing P6.231(b) recorded as a residue, closed deliberately.
   *
   * What this case still controls, and it is the part worth keeping: the 280
   * bound and the TITLE. The fence must not be mistaken for a bound (the inner
   * text is still exactly 280 characters) and must not make the two branches
   * indistinguishable again (the title is the provider's, not the fallback's
   * "Unsummarized provider text …", and the fence's own source name differs).
   */
  it('P6.609: the citation branch is fenced too — the 280 bound is the INNER text, and the branches stay distinguishable', () => {
    const text = `intro ${'z'.repeat(600)} tail`;
    const [result] = parseResponsesApiResults(cited(text, 6, 606), 'nessy', 5);

    expect(result!.title).toBe('A');
    expect(result!.url).toBe('https://example.com/a');
    expect(result!.description).toBe(
      `<untrusted source="${SEARCH_CITATION_FENCE_SOURCE}">\n${'z'.repeat(280)}\n</untrusted>`,
    );
    // The bound did not move: what is bounded is the text inside the fence.
    expect(result!.description.split('\n')[1]).toHaveLength(280);
    // Two different fences for two different things, so a reader of the turn can
    // still tell an excerpt beside a URL from a whole unsummarised answer.
    expect(SEARCH_CITATION_FENCE_SOURCE).not.toBe(SEARCH_FALLBACK_FENCE_SOURCE);
    expect(result!.description).not.toContain(SEARCH_FALLBACK_FENCE_SOURCE);
  });

  /**
   * The one shape that must NOT gain a fence: a citation with no resolvable
   * excerpt. An empty fence is two lines of structure around nothing, which is
   * the same objection the fallback answers by throwing.
   */
  it('P6.609 control: a citation with no excerpt stays empty rather than becoming an empty fence', () => {
    const noOffsets = {
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'body',
          annotations: [{ type: 'url_citation', url: 'https://example.com/b', title: 'B' }],
        }],
      }],
    };
    const [result] = parseResponsesApiResults(noOffsets, 'nessy', 5);
    expect(result!.title).toBe('B');
    expect(result!.description).toBe('');
  });

  it('still refuses an empty answer rather than returning an empty fence', () => {
    expect(() => parseResponsesApiResults(prose(''), 'nessy', 5)).toThrow('Search returned no content');
  });
});

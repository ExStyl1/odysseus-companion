/**
 * P2.184 — A PER-ITEM LOOP MUST CONTAIN ITS OWN FAILURE, or one bad item
 * silently becomes zero items processed.
 *
 * `parseWebSearchResult` mapped over the links array calling `new URL(link.url)`
 * with the only `try` OUTSIDE the map, so ONE malformed url — from whatever the
 * search tool returned, i.e. fully upstream-controlled — dropped the ENTIRE
 * formatted Links section back to a raw JSON blob. Display only, and still
 * every other link in the batch.
 *
 * The failure is LABELLED on the record that already exists: the entry keeps
 * its row and its link and loses the domain prefix it could not compute, with
 * the reason in the prefix's place. Not a second record, and no new i18n key —
 * this file's other strings are English literals too.
 */
import { describe, expect, it } from 'bun:test'

import { parseWebSearchResult } from '../tool-parsers'

const wrap = (links: unknown): string => `Result text\nLinks: ${JSON.stringify(links)}\n`

describe('parseWebSearchResult — one bad url costs one row', () => {
  it('keeps every other link when one url will not parse', () => {
    const output = parseWebSearchResult(wrap([
      { title: 'First', url: 'https://www.example.com/a' },
      { title: 'Broken', url: 'ht!tp://%%%' },
      { title: 'Third', url: 'https://docs.example.org/b' },
    ]))

    expect(output).toContain('**Links:**')
    // Identity on each rendered row, not "the output is non-empty".
    expect(output).toContain('- [example.com - First](https://www.example.com/a)')
    expect(output).toContain('- [docs.example.org - Third](https://docs.example.org/b)')
    // The bad entry survives, labelled, rather than taking the section with it.
    expect(output).toContain('- [Broken](ht!tp://%%%) (unparseable URL)')
    // And the whole-section fallback did NOT fire.
    expect(output).not.toContain('```json')
  })

  it('a section made only of bad urls still renders as a list', () => {
    const output = parseWebSearchResult(wrap([{ title: 'Only', url: 'ht!tp://%%%' }]))
    expect(output).toContain('**Links:**')
    expect(output).toContain('- [Only](ht!tp://%%%) (unparseable URL)')
    expect(output).not.toContain('```json')
  })

  it('POSITIVE CONTROL: an all-good section is unchanged by the containment', () => {
    const output = parseWebSearchResult(wrap([
      { title: 'First', url: 'https://www.example.com/a' },
    ]))
    expect(output).toContain('- [example.com - First](https://www.example.com/a)')
    expect(output).not.toContain('unparseable URL')
  })

  it('POSITIVE CONTROL: a non-link array still falls back to the code block', () => {
    // Before the containment this fallback was reached BY `new URL(undefined)`
    // throwing. Containing the throw would otherwise have started rendering
    // `- [undefined](undefined)` for it, so the shape check is load-bearing.
    const output = parseWebSearchResult(wrap([1, 2, 3]))
    expect(output).toContain('```json')
    expect(output).not.toContain('**Links:**')
    expect(output).not.toContain('undefined')
  })

  it('POSITIVE CONTROL: unparseable JSON still falls back to the code block', () => {
    // The bracket pair is what the section regex matches on; the CONTENT is
    // what `JSON.parse` refuses.
    const output = parseWebSearchResult('Links: [not json]\n')
    expect(output).toContain('```json')
    expect(output).not.toContain('**Links:**')
  })
})

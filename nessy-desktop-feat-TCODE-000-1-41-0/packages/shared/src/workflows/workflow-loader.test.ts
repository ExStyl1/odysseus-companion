import { describe, expect, it } from 'bun:test';

import { parseWorkflowRecipe } from './workflow-loader.ts';

/**
 * `meta` key-set policy (P2.145).
 *
 * The parser is OPEN for loading and the `WorkflowMeta` type is CLOSED for
 * consumption: requiredness and known-field types are enforced, unknown keys
 * are ignored instead of failing the file. The contract behind that split is
 * quoted on `WorkflowMeta`; these cases pin the behaviour it produces.
 *
 * The positive case mirrors the shape Anthropic's `claude-security` 0.10.0
 * ships in `workflows/scan.js` (`{name, description, whenToUse, phases}`,
 * measured 2026-08-24) WITHOUT reading that file: a fixture pinned to an
 * installed plugin version rots the moment the plugin updates, and the
 * invariant under test is the shape, not the bytes.
 */
describe('parseWorkflowRecipe meta key policy', () => {
  it('loads whenToUse plus an unknown forward-compatible key, carrying only known fields', () => {
    const parsed = parseWorkflowRecipe(`
      export const meta = {
        name: 'scan',
        description: 'Security scan pipeline',
        whenToUse: 'Run by the Security Lead from the scan job.',
        phases: [{ title: 'Inventory' }],
        someFieldUpstreamAddedLater: { nested: ['still', 'pure', 'literal'] },
      };
      return 'scanned';
    `);

    // The upstream-shipped optional field round-trips...
    expect(parsed.meta.whenToUse).toBe('Run by the Security Lead from the scan job.');
    expect(parsed.meta.name).toBe('scan');
    expect(parsed.meta.description).toBe('Security scan pipeline');
    expect(parsed.meta.phases).toEqual([{ title: 'Inventory' }]);
    // ...and the unknown key neither fails the load nor leaks into the meta.
    expect(Object.keys(parsed.meta)).toEqual(['name', 'description', 'whenToUse', 'phases']);
    // The body split still lands after the whole `meta` block, extra keys and
    // all (only LEADING whitespace is stripped, so compare trimmed).
    expect(parsed.source.trim()).toBe(`return 'scanned';`);
  });

  it.each([
    // Requiredness is what catches a misspelled REQUIRED field — not the
    // key set. This is the control proving the check is not simply disabled.
    ['description missing entirely', `export const meta = { name: 'x' };`],
    ['description misspelled', `export const meta = { name: 'x', descriptoin: 'oops' };`],
    ['name not a string', `export const meta = { name: 42, description: 'ok' };`],
    // Known optional fields keep their types: open to new keys is not open to
    // any value on a key we do consume.
    ['whenToUse not a string', `export const meta = { name: 'x', description: 'ok', whenToUse: 42 };`],
    ['phases not an array', `export const meta = { name: 'x', description: 'ok', phases: 'nope' };`],
  ])('still refuses %s', (_label, metaSource) => {
    expect(() => parseWorkflowRecipe(`${metaSource}\nreturn 1;`)).toThrow(
      /workflow meta must contain literal name and description strings/,
    );
  });
});

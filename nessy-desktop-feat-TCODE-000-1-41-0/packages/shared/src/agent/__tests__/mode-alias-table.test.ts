import { describe, expect, test } from 'bun:test';
import { parsePermissionMode } from '../mode-types.ts';

/**
 * The shared mode alias table: every read path resolves spellings through
 * `parsePermissionMode`, so this matrix is the contract for all five
 * persisted-spelling doors (session JSONL headers and nested fields, managed
 * policy, agent frontmatter, automations). A spelling that was ever written
 * to disk must stay in this table forever.
 */
describe('permission mode alias table', () => {
  const matrix: Array<[string, string]> = [
    // Internal spellings (Claude's vocabulary).
    ['dontAsk', 'dontAsk'],
    // F1.1050 (DN-272): the retired Explore mode reads as plan forever (this row said explore → explore).
    ['explore', 'plan'],
    ['Explore', 'plan'],
    ['plan', 'plan'],
    ['default', 'default'],
    ['acceptEdits', 'acceptEdits'],
    ['auto', 'auto'],
    ['bypassPermissions', 'bypassPermissions'],
    ['manual', 'default'],
    // Pre-migration internal spellings — persisted on disk forever.
    ['safe', 'plan'], // explore's pre-migration spelling follows it to plan (F1.1050)
    ['ask', 'default'],
    ['allow-all', 'bypassPermissions'],
    // Legacy aliases.
    ['execute', 'bypassPermissions'],
    ['ask-to-edit', 'default'],
    ['automatic', 'auto'],
    ['accepts-edits', 'acceptEdits'],
    // Case- and separator-insensitive.
    ['Accept Edits', 'acceptEdits'],
    ['dont_ask', 'dontAsk'],
    ['BYPASSPERMISSIONS', 'bypassPermissions'],
    ['Default', 'default'],
  ];

  test.each(matrix)('resolves %s to %s', (spelling, mode) => {
    expect(parsePermissionMode(spelling)).toBe(mode as ReturnType<typeof parsePermissionMode> & string);
  });

  test('F1.1050: no spelling resolves to the retired explore — every result is one of the six modes', () => {
    const six = new Set(['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
    for (const [spelling] of matrix) expect(six.has(parsePermissionMode(spelling) as string)).toBe(true);
  });

  test('returns null for unknown spellings and prototype members', () => {
    expect(parsePermissionMode('sudo')).toBeNull();
    expect(parsePermissionMode('')).toBeNull();
    // The table is null-prototype: an Object.prototype member name must miss.
    expect(parsePermissionMode('constructor')).toBeNull();
    expect(parsePermissionMode('hasOwnProperty')).toBeNull();
  });
});

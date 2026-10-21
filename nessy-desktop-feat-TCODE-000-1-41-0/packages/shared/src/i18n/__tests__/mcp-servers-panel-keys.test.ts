/**
 * The unified MCP servers panel's strings must actually resolve.
 *
 * `lint:i18n:parity` and `lint:i18n:sorted` between them prove the locales
 * agree and are ordered. Neither can see a key that is missing from BOTH
 * locales: two files that are equally wrong are in parity. That hole is how a
 * row ships rendering `mcpServers.builtinUnavailable` as its own badge text.
 *
 * So this gate reads the KEYS OUT OF THE RENDERER SOURCE and drives each one
 * through the real i18next instance in every supported locale. A key added to
 * the panel and to no locale file fails here, which is the case the two lint
 * gates cannot reach.
 *
 * It replaces the `settings.builtinDpMcp.*` gate, which covered the separate
 * built-in MCP card. That card is gone (owner decision 2026-08-01 — a built-in
 * is an ordinary row of this panel, not a surface of its own), and its keys
 * with it; the coverage moved here rather than being dropped.
 *
 * Mutation probe: delete one `mcpServers.*` entry from en.json and ru.json →
 * this file goes red while both lint gates stay green.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupI18n } from '../setupI18n';
import { SUPPORTED_LANGUAGE_CODES } from '../languages';

const RENDERER = join(import.meta.dir, '../../../../../apps/electron/src/renderer');

/**
 * Every QUOTED `mcpServers.*` literal anywhere in the renderer — tests included,
 * so moving the panel between files cannot quietly empty this gate.
 *
 * Tests must stay in scope, but NOT for the reason this docblock gave until
 * W4-e drove it. It read: "the built-in badge keys are built dynamically, so a
 * test's stub translation map is the only place they appear literally at all."
 * The second half is true and the first is not — nothing composes
 * `mcpServers.origin*` anywhere in this tree, dynamically or otherwise. The
 * three badge keys (`originBuiltin`, `originPlugin`, `originUser`) appear ONLY
 * in three test stub maps: this panel's own test and `source-card.test.tsx`
 * carry them because the badges LEFT the row (`McpServersPanel.tsx`'s docblock
 * records where each went) and the stubs outlived them. They are held in
 * `scripts/i18n-unreachable-keys.txt` rather than deleted, because deleting
 * them also means editing those stub maps, which is a change to files this row
 * does not own.
 *
 * The real reason tests stay in scope is the one the sentence buried: moving the
 * panel between files must not quietly empty this gate. That reason does not
 * depend on anything being built dynamically, and stating it as if it did is
 * how a docblock talks a reader out of checking.
 *
 * The quote delimiter is what makes that safe, and it is load-bearing. A plugin
 * manifest path reads `mcpServers.<server-name>.command`, and an unquoted scan
 * took `mcpServers.chrome` out of the prose `mcpServers.chrome-devtools` in
 * `plugin-info-diagnostics.test.tsx` — the character class stops at the hyphen —
 * then demanded a translation for a key that is not a key. Requiring the closing
 * quote immediately after the key drops that match (a hyphen follows, not a
 * quote) while keeping every real `t('mcpServers.x')` call and every stub entry.
 */
const keysUsedByThePanel = [...new Set(
  // `scanSync` returns an IterableIterator, which has no `flatMap` — spread it
  // into an array first. tsc caught this; the bun runner did not, because the
  // iterator does happen to carry the method at runtime.
  [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: RENDERER, absolute: true })]
    .flatMap((file: string) => readFileSync(file, 'utf-8').match(/['"`]mcpServers\.[A-Za-z0-9_]+['"`]/g) ?? [])
    .map((quoted: string) => quoted.slice(1, -1)),
)].sort();

const i18n = setupI18n();

describe('MCP servers panel strings', () => {
  it('finds the panel keys in the renderer (the gate is not vacuous)', () => {
    expect(keysUsedByThePanel.length).toBeGreaterThanOrEqual(10);
  });

  it('covers the built-in row badges, which have no other gate', () => {
    // Named rather than counted: these two are what a built-in row renders,
    // and a rename that silently drops them would still satisfy the count.
    expect(keysUsedByThePanel).toContain('mcpServers.originBuiltin');
    expect(keysUsedByThePanel).toContain('mcpServers.builtinUnavailable');
  });

  for (const lang of SUPPORTED_LANGUAGE_CODES) {
    it(`resolves every key in ${lang}`, async () => {
      await i18n.changeLanguage(lang);
      for (const key of keysUsedByThePanel) {
        const value: string = i18n.t(key);
        // i18next returns the key itself when nothing is registered for it.
        expect(value, `${key} is unresolved in ${lang}`).not.toBe(key);
        expect(value.trim().length, `${key} is empty in ${lang}`).toBeGreaterThan(0);
      }
    });
  }
});

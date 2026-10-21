/**
 * The Sources card's strings must actually resolve.
 *
 * Same hole as the MCP-panel gate beside this file: `lint:i18n:parity` and
 * `lint:i18n:sorted` prove the locales agree and are ordered, and NEITHER can
 * see a key that is missing from BOTH — two files that are equally wrong are in
 * parity. Measured, not assumed.
 *
 * The 2026-08-01 card rework moved every Sources/Skills row label behind
 * `SOURCE_CATEGORY_BADGE` (`lib/source-card.ts`) and every Enable/Disable label
 * behind `sourceEnablementActions` (`lib/source-enablement.ts`). Both now hold
 * i18n keys as DATA rather than as `t()` call sites, which is exactly the shape
 * a rename breaks silently: a mistyped key in a table renders the key itself and
 * type-checks clean.
 *
 * So this reads the keys out of the renderer source and drives each through the
 * real i18next instance in every supported locale.
 *
 * Mutation probe: change one entry of `SOURCE_CATEGORY_BADGE` to a key that is
 * in neither locale → this file goes red while both lint gates stay green.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupI18n } from '../setupI18n';
import { SUPPORTED_LANGUAGE_CODES } from '../languages';

const RENDERER = join(import.meta.dir, '../../../../../apps/electron/src/renderer');

/** Both prefixes anywhere in the renderer, so moving a table cannot empty this gate. */
const KEY_PATTERN = /(?:sourcesList|sourcesManagement)\.[A-Za-z0-9_]+/g;

const keysUsedByTheCard = [...new Set(
  // `scanSync` returns an IterableIterator, which has no `flatMap` — spread it
  // into an array first.
  [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: RENDERER, absolute: true })]
    .flatMap((file: string) => readFileSync(file, 'utf-8').match(KEY_PATTERN) ?? []),
)].sort();

const i18n = setupI18n();

describe('Sources card strings', () => {
  it('finds the card keys in the renderer (the gate is not vacuous)', () => {
    expect(keysUsedByTheCard.length).toBeGreaterThanOrEqual(20);
  });

  it('covers the category badge and the single Enable/Disable action', () => {
    // Named rather than counted: these are the labels the reworked card and
    // menu render, and a rename that dropped them would still satisfy a count.
    for (const key of [
      // One per Sources subsection — the 2026-08-01 sweep brought the Plugins
      // and Hooks rows onto the same card, so their labels are card labels now.
      'sourcesList.typeMcp', 'sourcesList.typeApi',
      'sourcesList.typeLocal', 'sourcesList.typeSkill',
      'sourcesList.pluginBadge', 'sourcesList.typeHook',
      'sourcesManagement.enable', 'sourcesManagement.disable',
      'sourcesManagement.enableInWorkspace', 'sourcesManagement.disableInWorkspace',
      'sourcesManagement.enableInProject', 'sourcesManagement.disableInProject',
    ]) {
      expect(keysUsedByTheCard, key).toContain(key);
    }
  });

  for (const lang of SUPPORTED_LANGUAGE_CODES) {
    it(`resolves every key in ${lang}`, async () => {
      await i18n.changeLanguage(lang);
      for (const key of keysUsedByTheCard) {
        const value: string = i18n.t(key);
        // i18next returns the key itself when nothing is registered for it.
        expect(value, `${key} is unresolved in ${lang}`).not.toBe(key);
        expect(value.trim().length, `${key} is empty in ${lang}`).toBeGreaterThan(0);
      }
    });
  }
});

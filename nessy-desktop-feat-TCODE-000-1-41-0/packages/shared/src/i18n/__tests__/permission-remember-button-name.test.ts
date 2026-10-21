/**
 * UB12.46 (born by UB14.24, L-COMPOSER, 2026-10-16) — the permission card's remember sentence names
 * the button it is about, and since UB14.24 it sits in the card's foot right under that button. The
 * Russian sentences named it in English («Always Allow» сохраняет …) while the Russian button reads
 * `chat.permissionAlwaysAllow` («Разрешить всегда»).
 *
 * Which sentences name the button is read off `en.json` (the English sentence quotes the English
 * label), so a fourth sentence that names it joins the check without an edit here.
 */
import { describe, expect, it } from 'bun:test';
import en from '../locales/en.json';
import ru from '../locales/ru.json';

const EN = en as Record<string, string>;
const RU = ru as Record<string, string>;
const FAMILY = 'chat.permissionRemember.';
const BUTTON = 'chat.permissionAlwaysAllow';

/** The button's English label as a word: "Always Allowed Tools" (a skill's tool list) is not it. */
const LATIN_LABEL = /\bAlways Allow\b/i;

const family = Object.keys(EN).filter(key => key.startsWith(FAMILY));
const naming = family.filter(key => EN[key]!.includes(EN[BUTTON]!));

describe('UB12.46 · the Russian remember sentences name the Russian button', () => {
  it('every ru sentence that names the button quotes the ru label of chat.permissionAlwaysAllow', () => {
    // The derivation is not empty: the three Always-Allow sentences, and only they.
    expect(naming.sort()).toEqual([`${FAMILY}repository`, `${FAMILY}session`, `${FAMILY}workspace`]);
    for (const key of naming) expect(RU[key], key).toContain(`«${RU[BUTTON]}»`);
  });

  it('BOUNDARY: a sentence that does not name the button in English does not name it in Russian', () => {
    const silent = family.filter(key => !naming.includes(key));
    expect(silent.length).toBeGreaterThan(0);
    for (const key of silent) expect(RU[key], key).not.toContain(RU[BUTTON]!);
  });

  it('NEGATIVE (control): no ru value carries the Latin button label, and the instrument can see one', () => {
    // The instrument fires on the English label and on the pre-fix Russian sentence,
    // and stays quiet on the skill page's quoted "Always Allowed Tools".
    expect(LATIN_LABEL.test(EN[BUTTON]!)).toBe(true);
    expect(LATIN_LABEL.test('«Always Allow» сохраняет эту команду для репозитория')).toBe(true);
    expect(LATIN_LABEL.test('Как "Always Allowed Tools" взаимодействует с режимами разрешений:')).toBe(false);
    const leaks = Object.entries(RU).filter(([, value]) => LATIN_LABEL.test(value)).map(([key]) => key);
    expect(leaks).toEqual([]);
  });
});

/**
 * UB12.85 (born by UB12.46, L-MISC, 2026-10-16) — the skill page's permission-modes lead-in
 * (`skillInfo.permissionModesDesc`, read by `CapabilityPermissionModesSection.tsx`) quoted the
 * English concept name in Russian («Как "Always Allowed Tools" взаимодействует …»), while the same
 * section's empty state, `capabilityDetail.noPermissionModes`, names that list in Russian words
 * («автоматически разрешённых инструментов»). The ru lead-in now uses the same words.
 *
 * en stays upstream v0.15.1's sentence (`packages/shared/src/i18n/locales/en.json`, unchanged there).
 */
import { describe, expect, it } from 'bun:test';
import en from '../locales/en.json';
import ru from '../locales/ru.json';

const EN = en as Record<string, string>;
const RU = ru as Record<string, string>;
const KEY = 'skillInfo.permissionModesDesc';
const EMPTY_STATE = 'capabilityDetail.noPermissionModes';

/** Product and runtime names a Russian sentence may still spell in Latin letters. */
const BRAND_NAMES = ['Nessy', 'Claude', 'Codex', 'Pi'];
/** The words both ru sentences use for the list (the stem covers every case ending). */
const LIST_STEM = 'автоматически разрешённ';

function latinOutsideBrands(value: string): string[] {
  const stripped = BRAND_NAMES.reduce((text, brand) => text.replace(new RegExp(`\\b${brand}\\b`, 'g'), ''), value);
  return stripped.match(/[A-Za-z]+/g) ?? [];
}

describe('UB12.85 · the ru skill permission-modes lead-in names the list in Russian', () => {
  it('the ru value carries no Latin word outside brand names and names the list as the empty state does', () => {
    expect(latinOutsideBrands(RU[KEY]!)).toEqual([]);
    // The stem is the empty state's own wording, not an invented one.
    expect(RU[EMPTY_STATE]).toContain(LIST_STEM);
    expect(RU[KEY]).toContain(LIST_STEM);
    expect(RU[KEY]).toContain('инструмент');
  });

  it('NEGATIVE (control): en is upstream\'s sentence, and the instrument sees the English concept name', () => {
    expect(EN[KEY]).toBe('How "Always Allowed Tools" interacts with permission modes:');
    // The instrument fires on the en value and on the pre-fix ru value, and stays quiet on a brand name.
    expect(latinOutsideBrands(EN[KEY]!).length).toBeGreaterThan(0);
    expect(latinOutsideBrands('Как "Always Allowed Tools" взаимодействует с режимами разрешений:')).toEqual([
      'Always', 'Allowed', 'Tools',
    ]);
    expect(latinOutsideBrands('Навык Claude')).toEqual([]);
  });
});

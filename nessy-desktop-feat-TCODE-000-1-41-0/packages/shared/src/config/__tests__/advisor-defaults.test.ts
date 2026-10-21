/**
 * P2.1 — the advisor's defaults land in ALL THREE sites.
 *
 * The P0.2 lesson recorded on `FALLBACK_CONFIG_DEFAULTS` in `storage.ts`: a key
 * that reaches the bundled `config-defaults.json` but not the in-code fallback
 * (or the schema) works on a normal launch and vanishes wherever the bundled
 * assets dir is missing — CI, the standalone server, a dev tree — which is the
 * known shipped-bug shape. Asserted mechanically here, per key, so the next
 * default added to one site fails until it reaches the other two.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigDefaultsSchema } from '../validators.ts';
import { FALLBACK_CONFIG_DEFAULTS } from '../storage.ts';

const bundled = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../apps/electron/resources/config-defaults.json', import.meta.url)),
    'utf8',
  ),
) as { defaults: Record<string, unknown> };

describe('advisor defaults reach all three sites', () => {
  it('site 1 — the bundled config-defaults.json carries both keys', () => {
    expect(bundled.defaults.advisorEnabled).toBe(false);
    expect(bundled.defaults.advisorModel).toBe('');
  });

  it('site 2 — FALLBACK_CONFIG_DEFAULTS carries the same two values', () => {
    expect(FALLBACK_CONFIG_DEFAULTS.defaults.advisorEnabled).toBe(false);
    expect(FALLBACK_CONFIG_DEFAULTS.defaults.advisorModel).toBe('');
  });

  it('the two sites agree — a one-place flip is what P0.2 measured', () => {
    expect(bundled.defaults.advisorEnabled).toBe(FALLBACK_CONFIG_DEFAULTS.defaults.advisorEnabled);
    expect(bundled.defaults.advisorModel).toBe(FALLBACK_CONFIG_DEFAULTS.defaults.advisorModel);
  });

  it('site 3 — the schema REQUIRES both keys', () => {
    const withoutEnabled = { ...FALLBACK_CONFIG_DEFAULTS, defaults: { ...FALLBACK_CONFIG_DEFAULTS.defaults } };
    delete (withoutEnabled.defaults as Record<string, unknown>).advisorEnabled;
    expect(ConfigDefaultsSchema.safeParse(withoutEnabled).success).toBe(false);

    const withoutModel = { ...FALLBACK_CONFIG_DEFAULTS, defaults: { ...FALLBACK_CONFIG_DEFAULTS.defaults } };
    delete (withoutModel.defaults as Record<string, unknown>).advisorModel;
    expect(ConfigDefaultsSchema.safeParse(withoutModel).success).toBe(false);
  });

  // Positive control for the row above: the shipped shape itself parses, so the
  // two failures are the missing keys and not a fixture the schema rejects.
  it('the shipped fallback parses as-is', () => {
    const result = ConfigDefaultsSchema.safeParse(FALLBACK_CONFIG_DEFAULTS);
    expect(result.success).toBe(true);
  });

  it('the bundled asset parses too', () => {
    expect(ConfigDefaultsSchema.safeParse(bundled).success).toBe(true);
  });
});

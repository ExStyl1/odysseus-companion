/**
 * P6.739 — the unattended floor is DECLARED at every site that declares a
 * default, and every one of them says what the gate actually does.
 *
 * P6.531 shipped `unattendedApprovalFallback` with a documented default of
 * `deny`: an unattended turn that no rule and no floor covers refuses, on all
 * three runtimes, where codex used to approve. The value reached
 * `config/unattended-approval.ts` (the resolver's own constant) and the strict
 * `StoredConfig` envelope in `validators.ts`, and reached NONE of the three
 * sites that declare a default — so `config-defaults.json`, the file whose own
 * description is *"Default configuration values for Nessy Desktop"* and the one
 * an operator reads to learn what the app ships, was silent about a floor that
 * names itself to the user in its own refusal sentence.
 *
 * The entry is DECLARATIVE and that is deliberate, stated here so the next
 * reader does not "fix" it into a lever:
 *
 *   - `syncConfigDefaults` rewrites the user's copy of `config-defaults.json`
 *     from the bundle on EVERY launch (R52's recorded reason for shipping
 *     `thinkingLevel` absent), so nothing an operator writes there survives. The
 *     levers are the `unattendedApprovalFallback` key in `config.json` and
 *     `NESSY_UNATTENDED_APPROVAL_FALLBACK`, in that order.
 *   - `config/unattended-approval.ts` is a LEAF module with no imports, by its
 *     own docblock, precisely so `config/` does not start importing `storage.ts`
 *     to answer a permission question. It resolves from its own constant.
 *
 * So the thing worth asserting is not that a reader consults the file — it is
 * that the four declarations cannot disagree with the constant the gate uses.
 * A shipped floor described one way and enforced another is the silent
 * divergence this whole row family exists to remove.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigDefaultsSchema } from '../validators.ts';
import { FALLBACK_CONFIG_DEFAULTS } from '../storage.ts';
import {
  UNATTENDED_APPROVAL_FALLBACK_DEFAULT,
  UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY,
  resolveUnattendedApprovalFallback,
} from '../unattended-approval.ts';

const bundled = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../apps/electron/resources/config-defaults.json', import.meta.url)),
    'utf8',
  ),
) as { defaults: Record<string, unknown> };

describe('the unattended floor is declared wherever a default is declared', () => {
  it('site 1 — the bundled config-defaults.json carries it', () => {
    expect(bundled.defaults[UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY]).toBe('deny');
  });

  it('site 2 — FALLBACK_CONFIG_DEFAULTS carries the same value', () => {
    expect(FALLBACK_CONFIG_DEFAULTS.defaults.unattendedApprovalFallback).toBe('deny');
  });

  it('site 3 — the schema REQUIRES it, so no copy can quietly lose it', () => {
    // `ConfigDefaultsSchema` is the shape guard both shipped copies and every
    // `ConfigDefaults` fixture are checked against. (It is NOT on the runtime
    // read path: `loadConfigDefaults` reads the file with `readJsonFileSync` and
    // never parses it through this schema — a sibling comment in `validators.ts`
    // said otherwise until P6.739 corrected it.)
    const without = { ...FALLBACK_CONFIG_DEFAULTS, defaults: { ...FALLBACK_CONFIG_DEFAULTS.defaults } };
    delete (without.defaults as Record<string, unknown>).unattendedApprovalFallback;
    expect(ConfigDefaultsSchema.safeParse(without).success).toBe(false);

    // Positive control: the shipped shapes themselves parse, so the failure
    // above is the missing key and not a fixture the schema rejects.
    expect(ConfigDefaultsSchema.safeParse(FALLBACK_CONFIG_DEFAULTS).success).toBe(true);
    expect(ConfigDefaultsSchema.safeParse(bundled).success).toBe(true);
  });

  it('and every declaration equals the constant the gate actually resolves', () => {
    // The assertion that matters. Three declarations and one enforcement; the
    // day someone moves the shipped floor in one of them, this fails.
    expect(UNATTENDED_APPROVAL_FALLBACK_DEFAULT).toBe('deny');
    expect(bundled.defaults[UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY])
      .toBe(UNATTENDED_APPROVAL_FALLBACK_DEFAULT);
    expect(FALLBACK_CONFIG_DEFAULTS.defaults.unattendedApprovalFallback)
      .toBe(UNATTENDED_APPROVAL_FALLBACK_DEFAULT);
    // Resolved with NO stored key and NO env, which is the shipped install.
    expect(resolveUnattendedApprovalFallback(undefined, {})).toBe(UNATTENDED_APPROVAL_FALLBACK_DEFAULT);
  });

  it('the config.json key still resolves without the env, and the env without the key', () => {
    // The two levers, unchanged by this row and asserted so the declaration
    // cannot be mistaken for one: a settings file alone answers, an env var
    // alone answers, and the settings file wins when both speak.
    expect(resolveUnattendedApprovalFallback({ [UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY]: 'allow' }, {}))
      .toBe('allow');
    expect(resolveUnattendedApprovalFallback(undefined, { NESSY_UNATTENDED_APPROVAL_FALLBACK: 'allow' }))
      .toBe('allow');
    expect(resolveUnattendedApprovalFallback(
      { [UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY]: 'deny' },
      { NESSY_UNATTENDED_APPROVAL_FALLBACK: 'allow' },
    )).toBe('deny');
  });
});

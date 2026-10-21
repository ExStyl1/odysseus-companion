/**
 * P6.811 — a misspelled key inside `config-defaults.json`'s `defaults` block was
 * OPERATOR-INVISIBLE.
 *
 * Verified at HEAD before this was written: `ConfigDefaultsSchema` scored hits
 * in three `config/__tests__/` files and NOWHERE else — it was test-only, and
 * the schema's own header says why that matters (`loadConfigDefaults` reads the
 * file with `readJsonFileSync` and never parses it through the schema, so
 * nothing is stripped and nothing is reported at runtime). The strict envelope
 * of P6.719 guards `config.json`; this is a different file, and nothing covered
 * it. A shipped `guardianEnabld` therefore produced a default that silently did
 * not take effect.
 *
 * What is asserted here is the DIAGNOSTIC, not a rejection: the check runs on
 * the startup path and must never throw, because a defaults file that fails to
 * describe one key must not cost the user their application.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { FALLBACK_CONFIG_DEFAULTS, reportConfigDefaultsProblems } from '../storage.ts';
import { ConfigDefaultsSchema } from '../validators.ts';

const realWarn = console.warn;

function captureWarnings(run: () => void): string[] {
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    run();
  } finally {
    console.warn = realWarn;
  }
  return lines;
}

afterEach(() => { console.warn = realWarn; });

describe('config-defaults.json is checked at load (P6.811)', () => {
  it('names BOTH halves of a misspelled key, and does not throw', () => {
    // The positive control first: the shipped defaults pass, so a warning below
    // cannot be the checker warning about everything.
    expect(ConfigDefaultsSchema.safeParse(FALLBACK_CONFIG_DEFAULTS).success).toBe(true);
    expect(captureWarnings(() => {
      reportConfigDefaultsProblems(JSON.stringify(FALLBACK_CONFIG_DEFAULTS), '/bundled/config-defaults.json');
    })).toEqual([]);

    const typo = JSON.parse(JSON.stringify(FALLBACK_CONFIG_DEFAULTS)) as Record<string, any>;
    typo.defaults.guardianEnabld = typo.defaults.guardianEnabled;
    delete typo.defaults.guardianEnabled;

    const warnings = captureWarnings(() => {
      reportConfigDefaultsProblems(JSON.stringify(typo), '/bundled/config-defaults.json');
    });
    expect(warnings).toHaveLength(1);
    const message = warnings[0]!;
    // A typo is TWO facts, and only the pair reads as a typo: the key that is
    // now missing, and the key that is not known. Either alone leaves the
    // operator guessing which of the two they got wrong.
    expect(message).toContain('defaults.guardianEnabled');
    expect(message).toContain('defaults.guardianEnabld');
    // It names the file, so the operator knows which copy to edit — the bundled
    // asset, since `syncConfigDefaults` rewrites the user's copy every launch.
    expect(message).toContain('/bundled/config-defaults.json');
    // And it says what the consequence is, rather than only that something is
    // off: an undelivered default is the whole of the harm.
    expect(message).toContain('will NOT take effect');
  });

  it('never throws, and stays silent on a file it cannot fault', () => {
    // The negative arm. Startup must survive every shape of a broken file: the
    // loader's own per-field normalisation keeps the other defaults working, and
    // a checker that throws would turn one undelivered default into a dead app.
    for (const broken of ['', 'not json', '[]', 'null', '{}', '{"defaults":3}']) {
      expect(() => captureWarnings(() => {
        reportConfigDefaultsProblems(broken, '/bundled/config-defaults.json');
      })).not.toThrow();
    }

    // ...and a workspace-level typo is caught by the same pass, so the check is
    // not silently scoped to one block.
    const wsTypo = JSON.parse(JSON.stringify(FALLBACK_CONFIG_DEFAULTS)) as Record<string, any>;
    wsTypo.workspaceDefaults.maxBudgetUSD = 5;
    const wsWarnings = captureWarnings(() => {
      reportConfigDefaultsProblems(JSON.stringify(wsTypo), '/bundled/config-defaults.json');
    });
    expect(wsWarnings).toHaveLength(1);
    expect(wsWarnings[0]!).toContain('workspaceDefaults.maxBudgetUSD');
    // The correctly-spelled sibling is still present, so THIS shape is an
    // unknown key alone — no missing-key noise beside it.
    expect(wsWarnings[0]!).not.toContain('workspaceDefaults.maxBudgetUsd:');

    // A file that is valid and complete warns about nothing at all: the control
    // that stops the two positives above passing for a checker that always
    // speaks.
    expect(captureWarnings(() => {
      reportConfigDefaultsProblems(JSON.stringify(FALLBACK_CONFIG_DEFAULTS), '/bundled/config-defaults.json');
    })).toEqual([]);
  });
});

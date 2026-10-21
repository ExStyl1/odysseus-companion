/**
 * B6 (plugins-and-marketplace plan) — the post-install checklist's connector
 * hint must not tell the user that no sign-in is needed.
 *
 * The hint opened with "No sign-in is needed now". On the owner's real record
 * the figma connector declares `auth.timing: "ON_INSTALL"` (and provenance
 * `connectorAuthTiming: "ON_INSTALL"`), and no install-time OAuth chain has
 * ever run for it — `PluginManagementResult.authRequests`, the only field the
 * renderer chains `performOAuth` over, is declared and assigned nowhere. So
 * that clause was false for exactly the connector whose sign-in mattered most,
 * and it is the sentence that sent the owner away looking for a sign-in that
 * the dialog said did not exist.
 *
 * The second clause is TRUE and must survive: the session-start pending-auth
 * feed 2b (`server-core/src/sessions/pending-auth-summary.ts`) emits an
 * `oauth` plugin server as a row with `canSignIn: true`, and that is the row
 * `PendingAuthNotice.tsx` renders a sign-in button on.
 *
 * This gate is locale-file content only — no environment, no host state. A new
 * locale with no entry in the tables below fails rather than passing silently.
 *
 * Mutation probe: restore either locale's old value → both blocks red.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES_DIR = join(import.meta.dir, '../locales');
const HINT_KEY = 'pluginChecklist.connectorHint';

const locales: Record<string, Record<string, string>> = {};
for (const file of readdirSync(LOCALES_DIR).filter(name => name.endsWith('.json'))) {
  locales[file.replace('.json', '')] = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf-8'));
}

/** The claim the hint must never make again, per locale. */
const DENIES_SIGN_IN: Record<string, RegExp> = {
  en: /\bno sign-?in\b|\bsign-?in\b[^.]*\bis not needed\b/i,
  // No `\b` around Cyrillic — JS word boundaries are ASCII-only and would
  // never fire between two Cyrillic letters, which is how "не нужно" passed.
  ru: /(вход|подключ)[^.]*не\s+нужн/i,
};

/** The true clause the rewrite must keep: where the sign-in is actually offered. */
const POINTS_AT_SESSION_NOTICE: Record<string, RegExp> = {
  en: /session notice/i,
  ru: /уведомлени/i,
};

describe('plugin install checklist — connector hint', () => {
  for (const [lang, translations] of Object.entries(locales)) {
    const hint = translations[HINT_KEY];

    it(`${lang} declares the hint and is covered by this gate`, () => {
      expect(typeof hint).toBe('string');
      // A new locale must extend both tables; passing by omission is the way
      // a false claim would slip back in unnoticed.
      expect(Object.keys(DENIES_SIGN_IN)).toContain(lang);
      expect(Object.keys(POINTS_AT_SESSION_NOTICE)).toContain(lang);
    });

    it(`${lang} never claims a sign-in is unnecessary`, () => {
      expect(hint).toBeDefined();
      expect(DENIES_SIGN_IN[lang]!.test(hint!)).toBe(false);
    });

    it(`${lang} still points the user at the session notice`, () => {
      expect(hint).toBeDefined();
      expect(POINTS_AT_SESSION_NOTICE[lang]!.test(hint!)).toBe(true);
    });
  }
});

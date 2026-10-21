/**
 * Mode labels have ONE text source (permission-modes audit, 2026-07-31).
 *
 * The i18n `mode.*` keys are the UI text source; PERMISSION_MODE_AGENT_LABELS
 * is the agent-facing English channel and must stay byte-equal to the `en`
 * locale so the two channels cannot drift. The locales once carried a dead
 * duplicate key family (`mode.askToEdit*`, and the canonical-name spellings
 * `mode.explore*` / `mode.execute*` minus the live FullDesc pair) plus a dead
 * short-description family (`mode.<id>Desc`) — the exact-set test below keeps
 * every locale's `mode.` namespace pinned to what production interpolates, so
 * a re-added dead key fails here even when parity/sorted stay green.
 */

import { describe, expect, test } from 'bun:test';
import {
  PERMISSION_MODE_AGENT_LABELS,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_TO_CANONICAL,
} from '../mode-types.ts';
import { LOCALE_REGISTRY } from '../../i18n/registry.ts';

/** Every mode.* key production interpolates: label, short label, full description. */
const LIVE_MODE_KEYS = PERMISSION_MODE_ORDER.flatMap(mode => [
  `mode.${mode}`,
  `mode.${mode}Short`,
  `mode.${PERMISSION_MODE_TO_CANONICAL[mode]}FullDesc`,
]).sort();

describe('mode labels have one source', () => {
  test('agent-facing English labels are byte-equal to the en locale labels', () => {
    const en = LOCALE_REGISTRY.en.messages as Record<string, string>;
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(PERMISSION_MODE_AGENT_LABELS[mode], mode).toBe(en[`mode.${mode}`]!);
    }
  });

  test('every locale defines every live mode key, non-empty', () => {
    for (const [code, entry] of Object.entries(LOCALE_REGISTRY)) {
      const messages = entry.messages as Record<string, string>;
      for (const key of LIVE_MODE_KEYS) {
        expect(messages[key], `${code} ${key}`).toBeString();
        expect(messages[key]!.length, `${code} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  test('no locale carries mode keys production never interpolates', () => {
    for (const [code, entry] of Object.entries(LOCALE_REGISTRY)) {
      const modeKeys = Object.keys(entry.messages)
        .filter(key => key.startsWith('mode.'))
        .sort();
      expect(modeKeys, code).toEqual(LIVE_MODE_KEYS);
    }
  });
});

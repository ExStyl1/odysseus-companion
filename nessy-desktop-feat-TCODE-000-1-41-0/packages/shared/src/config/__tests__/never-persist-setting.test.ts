/**
 * P6.502 — never-persist as a FIRST-CLASS setting.
 *
 * Delegated decision 2026-09-05 (Q-den 19) = option A. Option B (the retention
 * cap is the whole answer) was refused because the minimum retention is not
 * zero, and option C (let the cap reach zero) because that is a FALSE
 * never-persist: the transcript is written and then deleted. Both refusals are
 * asserted below against the live retention code rather than restated, so the
 * day either becomes untrue this row is told.
 *
 * The other half of this file is rule 19's invariant, which is not decorative:
 * `StoredConfigTopLevelSchema` is `.strict()`, so a key our own setter writes
 * and the envelope does not declare refuses the WHOLE `config.json` with
 * `UnsupportedStorageLayoutError` — costing the user every other setting in it
 * (the defect `eaa7c1916` was written for).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FALLBACK_CONFIG_DEFAULTS,
  InvalidRetentionDaysError,
  MIN_RETENTION_DAYS,
  getNeverPersistSessions,
  setRetentionDays,
} from '../storage.ts';
import { StoredConfigSchema, StoredConfigTopLevelSchema } from '../validators.ts';
import { STORAGE_LAYOUT_VERSION } from '../paths.ts';

const bundled = JSON.parse(readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'config-defaults.json'),
  'utf8',
)) as { defaults: Record<string, unknown> };

function storedConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...over,
  };
}

describe('the never-persist setting is declared everywhere it must be (P6.502)', () => {
  it('ships OFF in both default sources, and reads OFF with nothing stored', () => {
    // POSITIVE: the two sites that decide a fresh install agree. The bundled
    // file wins on a normal launch and the in-code fallback only when the assets
    // directory is missing, so a one-place value makes the answer depend on the
    // shape of the install.
    expect(FALLBACK_CONFIG_DEFAULTS.defaults.neverPersistSessions).toBe(false);
    expect(bundled.defaults.neverPersistSessions).toBe(false);
    // A mode that removes resume, rewind and search is a choice a person makes,
    // never one they are given.
    expect(getNeverPersistSessions()).toBe(false);
  });

  it('the strict envelope accepts the key our own setter writes', () => {
    // This is the whole reason the key is declared in StoredConfigKnownFields:
    // the top-level envelope is `.strict()`, so an undeclared key does not get
    // ignored — it refuses the entire config.json.
    expect(StoredConfigTopLevelSchema.safeParse(storedConfig({ neverPersistSessions: true })).success).toBe(true);
    const typed = StoredConfigSchema.safeParse(storedConfig({ neverPersistSessions: true }));
    expect(typed.success).toBe(true);
    expect(StoredConfigSchema.safeParse(storedConfig()).success).toBe(true);
  });

  it('a non-boolean is REPORTED rather than silently read as "persist normally"', () => {
    // NEGATIVE: `validateConfig()` runs StoredConfigSchema, and the reader
    // resolves anything but `true` to off — so without this type a typo would
    // turn the mode off with nobody told.
    expect(StoredConfigSchema.safeParse(storedConfig({ neverPersistSessions: 'yes' })).success).toBe(false);
    expect(StoredConfigSchema.safeParse(storedConfig({ neverPersistSessions: 0 })).success).toBe(false);
  });
});

describe('why the retention cap could not have been the answer (P6.502)', () => {
  it('the cap cannot express zero, so "never on disk" is unreachable through it', () => {
    // NEGATIVE, and it is the row's own premise: option B is refused by this
    // throw, and option C by the fact that a zero window would delete a
    // transcript that had already been written.
    expect(MIN_RETENTION_DAYS).toBe(1);
    expect(() => setRetentionDays(0)).toThrow(InvalidRetentionDaysError);
  });
});

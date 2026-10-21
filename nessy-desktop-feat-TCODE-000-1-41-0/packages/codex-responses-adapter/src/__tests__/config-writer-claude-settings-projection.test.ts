/**
 * P6.167 — the per-FAMILY answer to "does my `.claude/settings.json` do anything
 * on codex?".
 *
 * ## The premise the ledger had backwards, and what these tests hold
 *
 * Ledger L1 read `absent` for codex. It is false for the family that matters
 * most — the `permissions` block binds a codex session, through the same
 * permission DSL every runtime consults, with the credential floor additionally
 * mirrored into codex's own OS-enforced `[permissions.<profile>.filesystem]`
 * table. What was really missing is that the OTHER families differ from each
 * other and nothing said how.
 *
 * ## WHAT EACH TEST KILLS
 *
 *  - "every family carries a verdict, a reader and a reason" dies if a family is
 *    added with a blank cell. A table whose rows can be empty is a table that
 *    records a silence as an answer.
 *  - "the family set is the READERS' set" dies the day a new `.claude` settings
 *    reader lands in the host without a verdict here — the failure names the
 *    family, which is the whole reason the list is spelled out rather than
 *    derived from the documented key surface.
 *  - the two `projected` arms die if the projection stops: the credential floor
 *    mirror and the writable-roots projection are the two things `projected`
 *    CLAIMS, so they are asserted against the emitted TOML rather than against a
 *    verdict string.
 *  - "names only what codex does not honour" dies if the line starts naming
 *    host-enforced families — the false-divergence direction, which is worse than
 *    silence because it teaches a reader to distrust the true lines.
 *  - "one line per family however many spellings" dies if `claudeMdExcludes` and
 *    `instructionExcludes` are reported as two separate losses. They are one
 *    setting.
 *  - "an unlisted key is unread-by-host, not unprojectable" is the distinction
 *    the whole table exists for: a key nothing in this product reads on ANY
 *    runtime is a product-wide silence, and recording it as a codex defect would
 *    manufacture a gap.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexConfigToml,
  classifyClaudeSettingsFamilyKey,
  CLAUDE_SETTINGS_CODEX_PROJECTION,
  CLAUDE_SETTINGS_UNREAD_BY_HOST,
  formatCodexClaudeSettingsProjectionDiagnostics,
} from '../config-writer.ts';

const BASE = {
  codexHome: join(tmpdir(), 'nessy-p6167-unused'),
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
} as const;

const VERDICTS = ['projected', 'host-enforced', 'unprojectable', 'refused'] as const;

describe('P6.167 — the per-family projection table', () => {
  test('every family carries a verdict, a reader and a reason', () => {
    const families = Object.entries(CLAUDE_SETTINGS_CODEX_PROJECTION);
    expect(families.length).toBeGreaterThan(0);
    for (const [family, entry] of families) {
      expect(VERDICTS, `${family} has an unknown verdict`).toContain(entry.verdict);
      expect(entry.keys.length, `${family} names no settings key`).toBeGreaterThan(0);
      for (const key of entry.keys) expect(key.trim().length).toBeGreaterThan(0);
      // A reader is what makes the row checkable by the next person: it says
      // WHERE to go and disagree.
      expect(entry.reader.length, `${family} names no reader`).toBeGreaterThan(10);
      expect(entry.reason.length, `${family} carries no reason`).toBeGreaterThan(40);
    }
  });

  test('the family set is the READERS\' set, spelled out so a new one fails loudly', () => {
    // Enumerated by walking the in-tree readers of `.claude/settings.json` and
    // `.claude/settings.local.json`, not recalled. A reader added without a
    // verdict here is the failure this pin exists for.
    expect(Object.keys(CLAUDE_SETTINGS_CODEX_PROJECTION).sort()).toEqual([
      'crossSessionInbound',
      'env',
      'instructionExcludes',
      'permissions',
      'skillOverrides',
      'useAutoModeDuringPlan',
      'writableRoots',
    ]);
  });

  test('exactly one family is `refused`, and it is `env`', () => {
    // Owner decision of 2026-09-05 (sitting §1.2): refuse a settings-file
    // environment block permanently and disclose the divergence. `refused` is a
    // stronger claim than `unprojectable` — it says projecting it would be
    // WRONG, not merely impossible — so a second one appearing without an owner
    // decision behind it is worth a red test.
    const refused = Object.entries(CLAUDE_SETTINGS_CODEX_PROJECTION)
      .filter(([, entry]) => entry.verdict === 'refused')
      .map(([family]) => family);
    expect(refused).toEqual(['env']);
  });
});

describe('P6.167 — what `projected` actually claims, asserted against the TOML', () => {
  test('the permission family reaches codex\'s own OS-enforced filesystem table', () => {
    const toml = buildCodexConfigToml({
      ...BASE,
      mode: 'default',
      deniedReadPaths: ['/private/nessy/credentials.enc'],
    });
    expect(CLAUDE_SETTINGS_CODEX_PROJECTION.permissions!.verdict).toBe('projected');
    expect(toml).toContain('[permissions.nessy_runtime.filesystem]');
    expect(toml).toContain('"/private/nessy/credentials.enc" = "deny"');
  });

  test('the writable-roots family reaches the same table as a write grant', () => {
    const toml = buildCodexConfigToml({
      ...BASE,
      mode: 'default',
      writablePaths: ['/private/nessy/plugin-data/honey'],
    });
    expect(CLAUDE_SETTINGS_CODEX_PROJECTION.writableRoots!.verdict).toBe('projected');
    expect(toml).toContain('"/private/nessy/plugin-data/honey" = "write"');
  });
});

describe('P6.167 — the diagnostic names the whole of the difference and no more', () => {
  test('says nothing when the session carries no settings family', () => {
    expect(formatCodexClaudeSettingsProjectionDiagnostics(undefined)).toEqual([]);
    expect(formatCodexClaudeSettingsProjectionDiagnostics([])).toEqual([]);
  });

  test('names only what codex does not honour', () => {
    // Every host-enforced family plus the projected one, together. The line must
    // not fire: nothing here is lost on codex.
    expect(formatCodexClaudeSettingsProjectionDiagnostics([
      'permissions', 'skillOverrides', 'crossSessionInbound', 'useAutoModeDuringPlan',
    ])).toEqual([]);
  });

  test('fires for an unprojectable family and for the refused one', () => {
    const [excludes] = formatCodexClaudeSettingsProjectionDiagnostics(['claudeMdExcludes']);
    expect(excludes).toStartWith('codex-claude-settings-unprojected: ');
    expect(excludes).toContain('instructionExcludes');
    expect(excludes).toContain('project_doc_max_bytes');

    const [env] = formatCodexClaudeSettingsProjectionDiagnostics(['env']);
    expect(env).toContain('env');
    expect(env).toContain('2026-09-05');
    // The reason is the owner's, and the sentence has to survive being read by
    // someone who thinks the absence is an oversight.
    expect(env).toContain('PATH');
  });

  test('one line per family however many spellings the file carries', () => {
    const lines = formatCodexClaudeSettingsProjectionDiagnostics([
      'instructionExcludes', 'claudeMdExcludes', 'permissions',
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1 family');
    // The permission block is in the same file and is NOT a loss — the closing
    // sentence has to say so, or a user reads the line as "my settings file does
    // nothing here", which is the sentence this row exists to retire.
    expect(lines[0]).toContain('permission block in the same file DOES take effect');
  });

  test('an unlisted key is unread-by-host, not unprojectable', () => {
    for (const key of ['statusLine', 'cleanupPeriodDays', 'apiKeyHelper', 'nessyNotAKey']) {
      expect(classifyClaudeSettingsFamilyKey(key)).toBe(CLAUDE_SETTINGS_UNREAD_BY_HOST);
    }
    // Positive control on the same call: a key the table DOES claim resolves to
    // its family, so the assertion above is about membership and not about the
    // function always answering the same thing.
    const permissions = classifyClaudeSettingsFamilyKey('permissions');
    expect(permissions).not.toBe(CLAUDE_SETTINGS_UNREAD_BY_HOST);
    expect(typeof permissions === 'object' && permissions.family).toBe('permissions');
    // And an unlisted key never reaches the line either.
    expect(formatCodexClaudeSettingsProjectionDiagnostics(['statusLine'])).toEqual([]);
  });
});

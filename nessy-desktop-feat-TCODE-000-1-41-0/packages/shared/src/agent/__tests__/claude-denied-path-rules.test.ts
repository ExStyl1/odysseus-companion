/**
 * **P3.147 — the credential floor, translated into the Claude SDK's own rule
 * grammar.**
 *
 * The load-bearing assertions here are the two that a hand-rolled translation
 * gets wrong:
 *
 * 1. **A single leading slash is NOT absolute on their side.**
 *    `permissions.md#read-and-edit`: *"A pattern like `/Users/alice/file` isn't
 *    an absolute path. The single leading slash anchors at the settings source,
 *    not the filesystem root. Use `//Users/alice/file` for absolute paths."* A
 *    verbatim copy of one of our absolute patterns would therefore point
 *    somewhere else entirely — and, being a deny, would fail SILENTLY by
 *    matching nothing.
 * 2. **A pattern that does not translate must not become "deny nothing".**
 *    Every input lands in `mirrored` or in `rejected`; a rejection keeps the
 *    other eighteen and is reported by name on the diagnostic channel.
 *
 * The shipped floor is asserted against `apps/electron/resources/permissions/
 * default.json` — the copy a real install reads — rather than against a literal
 * list retyped here, so an entry added to the product is an entry this suite
 * sees.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildClaudeDeniedPathSettingsOptions,
  formatClaudeDeniedPathDiagnostics,
  mapDeniedPathsToClaudeRules,
} from '../claude-denied-path-rules.ts';

/** The floor a real install reads, not a copy of it. */
const SHIPPED_DENIED_PATHS: string[] = JSON.parse(
  readFileSync(
    join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
    'utf8',
  ),
).deniedPaths;

describe('the shipped floor reaches the SDK whole', () => {
  test('every shipped entry translates, and none is silently dropped', () => {
    const mapping = mapDeniedPathsToClaudeRules(SHIPPED_DENIED_PATHS);
    expect(SHIPPED_DENIED_PATHS.length).toBeGreaterThan(0);
    expect(mapping.rejected).toEqual([]);
    expect(mapping.mirrored).toEqual(SHIPPED_DENIED_PATHS);
    // Read AND Edit for each: `permissions.md#read-and-edit` says Claude Code
    // "checks file permissions against `Edit(path)` and `Read(path)` rules
    // only", so `Edit` is the spelling that reaches Write/NotebookEdit.
    expect(mapping.rules).toHaveLength(SHIPPED_DENIED_PATHS.length * 2);
  });

  test('the four shipped anchor shapes each land on the documented form', () => {
    const mapping = mapDeniedPathsToClaudeRules(SHIPPED_DENIED_PATHS);
    const rules = new Set(mapping.rules);
    // `~/` is spelled identically in both grammars.
    expect(rules.has('Read(~/.ssh/**)')).toBe(true);
    expect(rules.has('Edit(~/.ssh/**)')).toBe(true);
    expect(rules.has('Read(~/.docker/config.json)')).toBe(true);
    // Ours compiles `**` to `.*` whole-string-anchored, i.e. filesystem-wide,
    // which is `//` on their side and NOT a bare `**/`.
    expect(rules.has('Read(//**/.env)')).toBe(true);
    expect(rules.has('Read(//**/*.pem)')).toBe(true);
    expect(rules.has('Read(//**/id_ed25519)')).toBe(true);
    // NEGATIVE: the cwd-anchored spelling must never be what we send, because
    // it would silently narrow a filesystem-wide deny to one directory tree.
    expect(rules.has('Read(**/.env)')).toBe(false);
  });

  test('rules are sorted and deduplicated so the settings blob is stable', () => {
    const mapping = mapDeniedPathsToClaudeRules([...SHIPPED_DENIED_PATHS, ...SHIPPED_DENIED_PATHS]);
    expect(mapping.rules).toEqual([...mapping.rules].sort());
    expect(new Set(mapping.rules).size).toBe(mapping.rules.length);
    expect(mapping.rules).toHaveLength(SHIPPED_DENIED_PATHS.length * 2);
  });
});

describe('the anchor trap', () => {
  test('an absolute pattern gains the second slash rather than being copied', () => {
    const mapping = mapDeniedPathsToClaudeRules(['/etc/nessy/secrets/**']);
    expect(mapping.rules).toEqual(['Edit(//etc/nessy/secrets/**)', 'Read(//etc/nessy/secrets/**)']);
    // The failure this pins: a verbatim copy anchors at the settings source.
    expect(mapping.rules).not.toContain('Read(/etc/nessy/secrets/**)');
  });

  test('a pattern already root-anchored is left alone', () => {
    const mapping = mapDeniedPathsToClaudeRules(['//var/secrets/**']);
    expect(mapping.rules).toContain('Read(//var/secrets/**)');
    expect(mapping.rules).not.toContain('Read(///var/secrets/**)');
  });
});

describe('a pattern that does not translate is reported, never widened', () => {
  test.each([
    ['secrets/**', 'unanchored'],
    ['.env', 'unanchored'],
    ['./secrets/**', 'unanchored'],
    ['', 'unanchored'],
    ['~', 'bare-home'],
    ['~/**', 'bare-home'],
    ['~/.ssh/(id_rsa)', 'unsafe-in-rule-string'],
    ['~/.ssh/id_rsa)', 'unsafe-in-rule-string'],
    ['~/.ssh/id\nrsa', 'unsafe-in-rule-string'],
    ['C:\\Users\\me\\.ssh\\**', 'unsafe-in-rule-string'],
  ])('%s is rejected as %s', (pattern, reason) => {
    const mapping = mapDeniedPathsToClaudeRules([pattern]);
    expect(mapping.rules).toEqual([]);
    expect(mapping.mirrored).toEqual([]);
    expect(mapping.rejected).toEqual([{ pattern, reason: reason as never }]);
  });

  test('POSITIVE CONTROL: the same rig accepts a well-formed pattern', () => {
    const mapping = mapDeniedPathsToClaudeRules(['~/.ssh/id_rsa']);
    expect(mapping.rejected).toEqual([]);
    expect(mapping.rules).toContain('Read(~/.ssh/id_rsa)');
  });

  test('one bad entry does not take the rest of the floor with it', () => {
    const mapping = mapDeniedPathsToClaudeRules(['secrets/**', ...SHIPPED_DENIED_PATHS]);
    expect(mapping.rejected).toHaveLength(1);
    expect(mapping.mirrored).toEqual(SHIPPED_DENIED_PATHS);
    expect(mapping.rules).toHaveLength(SHIPPED_DENIED_PATHS.length * 2);
  });

  test('every input lands in exactly one bucket, so nothing vanishes', () => {
    const input = ['~/.aws/**', 'secrets/**', '**/.env', '~', '/etc/x'];
    const mapping = mapDeniedPathsToClaudeRules(input);
    expect(mapping.mirrored.length + mapping.rejected.length).toBe(input.length);
  });

  test('a rejection names the pattern and says the results half stays open', () => {
    const lines = formatClaudeDeniedPathDiagnostics(mapDeniedPathsToClaudeRules(['secrets/**', '~/.aws/**']));
    const rejection = lines.find(line => line.includes('secrets/**'));
    expect(rejection).toBeDefined();
    expect(rejection).toContain('unanchored');
    expect(rejection).toContain('search results');
    expect(rejection).toContain('our own gate still denies it');
  });
});

describe('the SDK option', () => {
  test('nothing to mirror means no option at all, so the spawn is unchanged', () => {
    expect(buildClaudeDeniedPathSettingsOptions(mapDeniedPathsToClaudeRules([]))).toEqual({});
    expect(buildClaudeDeniedPathSettingsOptions(mapDeniedPathsToClaudeRules(undefined))).toEqual({});
    // A list of only-untranslatable entries must also produce no option rather
    // than an empty deny array, which would read as "a floor was applied".
    expect(buildClaudeDeniedPathSettingsOptions(mapDeniedPathsToClaudeRules(['secrets/**']))).toEqual({});
  });

  test('the floor rides `settings.permissions.deny`, the flag layer', () => {
    const options = buildClaudeDeniedPathSettingsOptions(mapDeniedPathsToClaudeRules(SHIPPED_DENIED_PATHS));
    expect(options.settings?.permissions.deny).toContain('Read(//**/.env)');
    expect(options.settings?.permissions.deny).toHaveLength(SHIPPED_DENIED_PATHS.length * 2);
    // NOT `managedSettings`: the SDK drops that tier by default on a machine
    // that already has an admin managed-settings tier, which is the wrong
    // failure direction for a credential floor.
    expect(options).not.toHaveProperty('managedSettings');
  });
});

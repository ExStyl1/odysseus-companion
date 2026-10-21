/**
 * P6.534 — the WRITER half: the host's bundled-skills OFF switch becomes codex's
 * own `[skills.bundled] enabled = false`, and nothing else.
 *
 * The reader half is
 * `shared/src/agent/__tests__/codex-bundled-skills-off-switch.test.ts`.
 *
 * Native-first case (1), which is what makes this row one key rather than host
 * machinery: `SkillsConfig` in the pinned
 * `packages/codex-protocol/schema/config-schema.json` carries
 * `bundled` → `BundledSkillsConfig { enabled: boolean, default: true }`, the
 * exact analogue of the host switch. It had never been written, so a cold
 * managed `CODEX_HOME` came back holding codex's own bundled tree (87 entries,
 * shipped `darwin-arm64` build, 2026-09-03).
 *
 * The arms read the config OFF DISK from a real `CODEX_HOME`: a capture of the
 * options object would pass for a writer that never emitted the key.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCodexConfig } from '../config-writer.ts';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

function configWith(over: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'p6534-home-'));
  try {
    writeCodexConfig({ codexHome: home, model: MODEL, adapterPort: 45123, ...over });
    return readFileSync(join(home, 'config.toml'), 'utf8');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('P6.534 · [skills.bundled] is written only in the OFF position', () => {
  test('false writes the table and the single key', () => {
    const toml = configWith({ bundledSkillsEnabled: false });
    expect(toml).toContain('[skills.bundled]');
    expect(toml).toMatch(/^\[skills\.bundled\]\nenabled = false$/m);
  });

  test('true writes NOTHING — codex\'s own default is already true', () => {
    // Not the previous assertion inverted. `BundledSkillsConfig.enabled` defaults
    // to `true`, so writing our `true` would re-assert a default we did not
    // choose on a subsystem whose defaults are codex's.
    expect(configWith({ bundledSkillsEnabled: true })).not.toContain('[skills');
  });

  test('an absent option writes NOTHING', () => {
    const toml = configWith({});
    expect(toml).not.toContain('[skills');
    // The positive control: the writer did emit a config, so the absence above
    // is a measurement rather than an empty file.
    expect(toml).toContain(`model = "${MODEL}"`);
  });

  test('the table sits with the other tables, so nothing bare lands inside it', () => {
    // The placement trap this file inherits from `[memories]` and `[agents]`:
    // any bare `key = value` emitted after a table header belongs to that table.
    // So the only line between this header and the next one must be its own key.
    const toml = configWith({ bundledSkillsEnabled: false });
    const after = toml.slice(toml.indexOf('[skills.bundled]') + '[skills.bundled]\n'.length);
    const nextTable = after.indexOf('\n[');
    const body = nextTable === -1 ? after : after.slice(0, nextTable);
    expect(body.trim()).toBe('enabled = false');
  });
});

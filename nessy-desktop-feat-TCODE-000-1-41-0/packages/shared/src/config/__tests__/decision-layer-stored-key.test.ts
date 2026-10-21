/**
 * UB6.1 (DA1.72) — the guard fixture for the `decisionLayer` StoredConfig key.
 *
 * Three things are pinned here and nothing else: that the key survives the
 * strict envelope (an undeclared key our own setter writes would refuse the
 * WHOLE config.json — `UnsupportedStorageLayoutError`); that the reader is OFF
 * by default and normalizes garbage to defaults (fail closed to today's
 * behaviour, the layer's own invariant); and that the setter round-trips a
 * patch (features merge key-wise, `null` clears), refusing by name when
 * config.json is absent.
 *
 * Counted in UB6.1's tracker ("envelope guard 5") but left uncommitted by
 * 6ca4e5e43; adopted 2026-10-16 with the null-clear and refusal arms made
 * discriminating (each could pass before without the behaviour it names).
 *
 * The child spawn pays storage.ts's cold module graph (see
 * `cross-session-inbound-user-setting.test.ts` for the measurement that set the
 * 300 s budget).
 */

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getDecisionLayerSettings, setDecisionLayerSettings } from '../storage.ts';
import { STORAGE_LAYOUT_VERSION } from '../paths.ts';

setDefaultTimeout(300_000);

const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

function tempConfigDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function storedConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...over,
  };
}

function runInConfigDir(configDir: string, expression: string): { exitCode: number; stdout: string; stderr: string } {
  const storageModule = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;
  const run = Bun.spawnSync(
    [process.execPath, '--eval', `import * as S from '${storageModule}'; ${expression}`],
    { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' },
  );
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

describe('decisionLayer survives the strict stored-config envelope (UB6.1)', () => {
  it('loads a config.json that sets decisionLayer and normalizes it', () => {
    const configDir = tempConfigDir('nessy-decision-envelope-');
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify(storedConfig({ decisionLayer: { enabled: true, provider: 'laya', deadlineMs: 5 } })),
      'utf-8',
    );
    const run = runInConfigDir(configDir, `console.log(JSON.stringify(S.getDecisionLayerSettings()))`);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const settings = JSON.parse(run.stdout.toString().trim());
    expect(settings.enabled).toBe(true);
    expect(settings.provider).toBe('laya');
    expect(settings.deadlineMs).toBe(250); // clamped to DECISION_MIN_DEADLINE_MS
  });

  it('reads OFF by default when the key is absent, and garbage reads as defaults', () => {
    const absent = tempConfigDir('nessy-decision-absent-');
    writeFileSync(join(absent, 'config.json'), JSON.stringify(storedConfig()), 'utf-8');
    const run = runInConfigDir(absent, `console.log(JSON.stringify(S.getDecisionLayerSettings()))`);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const settings = JSON.parse(run.stdout.toString().trim());
    expect(settings.enabled).toBe(false);
    expect(settings.provider).toBe('typesafe');

    const garbage = tempConfigDir('nessy-decision-garbage-');
    writeFileSync(join(garbage, 'config.json'), JSON.stringify(storedConfig({ decisionLayer: { enabled: 'yes', provider: 42 } })), 'utf-8');
    const run2 = runInConfigDir(garbage, `console.log(JSON.stringify(S.getDecisionLayerSettings()))`);
    expect(run2.exitCode, run2.stderr.toString()).toBe(0);
    expect(JSON.parse(run2.stdout.toString().trim()).enabled).toBe(false);
  });

  it('setDecisionLayerSettings merges a patch key-wise and null clears', () => {
    const configDir = tempConfigDir('nessy-decision-setter-');
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(storedConfig()), 'utf-8');
    // The first patch SETS a baseUrl so the second patch's `null` has something
    // to clear: asserting `undefined` after a null with nothing set before would
    // pass whether or not null clears.
    const expression = `
      const first = S.setDecisionLayerSettings({ enabled: true, provider: 'laya', baseUrl: 'https://decide.fixture.invalid/v1', features: { decideTool: false } });
      S.setDecisionLayerSettings({ baseUrl: null, model: 'auto' });
      console.log(JSON.stringify({ first, final: S.getDecisionLayerSettings() }));
    `;
    const run = runInConfigDir(configDir, expression);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const { first, final: settings } = JSON.parse(run.stdout.toString().trim());
    expect(first.baseUrl).toBe('https://decide.fixture.invalid/v1');
    expect(settings.enabled).toBe(true);
    expect(settings.provider).toBe('laya');
    expect(settings.features.decideTool).toBe(false);
    expect(settings.model).toBe('auto');
    expect(settings.baseUrl).toBeUndefined(); // the null cleared the value the first patch set
  });
});

// Direct imports for the test process's own graph (no child): the setter's
// in-process shape is the same code the child ran above.
describe('getDecisionLayerSettings in-process', () => {
  it('returns normalized settings off by default', () => {
    const settings = getDecisionLayerSettings();
    expect(settings.enabled).toBe(false);
    expect(typeof settings.deadlineMs).toBe('number');
  });

  it('refuses to persist when config.json is absent rather than pretending', () => {
    const empty = tempConfigDir('nessy-decision-empty-');
    // No config.json in the dir at all.
    const storageModule = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;
    const run = Bun.spawnSync(
      [process.execPath, '--eval', `import * as S from '${storageModule}'; try { S.setDecisionLayerSettings({ enabled: true }); console.log('NO-THROW'); } catch (error) { console.log('THREW ' + (error instanceof Error ? error.message : String(error))); }`],
      { env: { ...process.env, NESSY_CONFIG_DIR: empty }, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    // The setter's OWN refusal, not any throw on the way (an import or envelope
    // failure would also land in the catch).
    expect(run.stdout.toString().trim()).toBe('THREW Cannot save decision model settings: config.json is not initialized');
  });
});

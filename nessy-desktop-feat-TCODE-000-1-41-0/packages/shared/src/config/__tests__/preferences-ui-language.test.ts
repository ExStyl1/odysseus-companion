/**
 * Tests for the internal `uiLanguage` preference field that backs main-process
 * i18n hydration. See packages/shared/CLAUDE.md → "Cross-process language persistence".
 *
 * `CONFIG_DIR` is captured at module-load from `process.env.NESSY_CONFIG_DIR`,
 * so each scenario runs in a subprocess with its own tmpdir — the same pattern
 * `apps/electron/src/main/__tests__/i18n-bootstrap.test.ts` uses.
 */
import { describe, it, expect, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

/**
 * The budget is set against the MEASURED FLOOR of one scenario, not against
 * zero — 15 s was below it and the whole suite read as a product defect.
 *
 * G-1's full-gate attribution recorded this file as *"`resolveTitleLanguageName`
 * auto-detects on an explicit English setting"* — a product read on `config/`.
 * It is not. Driven directly (2026-09-03), the function answers `'English'` for
 * `{ uiLanguage: 'en' }`, which is exactly what the assertion expects. What
 * fails is the RIG: every scenario here pays a whole `Bun.spawnSync` of a bun
 * child that compiles the `preferences.ts` chain, and that spawn was TIMED at
 * **27 034 ms at load 12.8** — 1.8x over the old 15 s — while the same script
 * run straight from a shell (one bun start, no sibling bun processes) cost
 * ~2 s. Fifteen of the sixteen tests failed identically, at ~15 000 ms each,
 * with `exitCode: -1` (the child killed, never a wrong answer).
 *
 * So: not starvation of this suite by its neighbours, and not a defect —
 * a per-scenario subprocess cost with a budget written before the cost was
 * measured. 120 s is the same explicit budget
 * `apps/electron/.../slash-command-help-table.test.ts` carries for its own
 * measured import.
 */
setDefaultTimeout(120_000);

const PREFS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'preferences.ts')).href;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(configDir: string, script: string): RunResult {
  const result = Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...process.env, NESSY_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function setupDir(): { configDir: string; prefsFile: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'preferences-ui-lang-'));
  return { configDir, prefsFile: join(configDir, 'preferences.json') };
}

function writeRawPrefs(prefsFile: string, contents: Record<string, unknown>) {
  writeFileSync(prefsFile, JSON.stringify(contents, null, 2), 'utf-8');
}

describe('preferences.uiLanguage', () => {
  describe('getCoAuthorPreference', () => {
    it('defaults to false when the preference is unset', () => {
      const { configDir } = setupDir();
      try {
        const r = runScript(configDir, `
          import { getCoAuthorPreference } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: getCoAuthorPreference() }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: false });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('returns true only when explicitly enabled', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { includeCoAuthoredBy: true });
        const r = runScript(configDir, `
          import { getCoAuthorPreference } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: getCoAuthorPreference() }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: true });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  describe('getPersistedUiLanguage', () => {
    it('returns undefined when the file does not exist', () => {
      const { configDir } = setupDir();
      try {
        const r = runScript(configDir, `
          import { getPersistedUiLanguage } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: null });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('returns undefined when the field is missing', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { name: 'Alice' });
        const r = runScript(configDir, `
          import { getPersistedUiLanguage } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: null });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('returns the code when valid', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { uiLanguage: 'ru' });
        const r = runScript(configDir, `
          import { getPersistedUiLanguage } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: 'ru' });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('returns undefined for unsupported codes (validates against the registry)', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { uiLanguage: 'xx' });
        const r = runScript(configDir, `
          import { getPersistedUiLanguage } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: null });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  describe('setPersistedUiLanguage', () => {
    it('writes the value and getter reads it back', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        const r = runScript(configDir, `
          import { setPersistedUiLanguage, getPersistedUiLanguage } from '${PREFS_MODULE}';
          setPersistedUiLanguage('ru');
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: 'ru' });
        expect(existsSync(prefsFile)).toBe(true);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('is idempotent — does not rewrite the file when value is unchanged', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        const r = runScript(configDir, `
          import { setPersistedUiLanguage } from '${PREFS_MODULE}';
          import { statSync } from 'fs';
          setPersistedUiLanguage('ru');
          const first = statSync('${prefsFile}').mtimeMs;
          const start = Date.now();
          while (Date.now() - start < 30) {}
          setPersistedUiLanguage('ru');
          const second = statSync('${prefsFile}').mtimeMs;
          console.log(JSON.stringify({ first, second }));
        `);
        expect(r.exitCode).toBe(0);
        const { first, second } = JSON.parse(r.stdout);
        expect(second).toBe(first);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('preserves unrelated fields', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { name: 'Alice', timezone: 'Europe/Budapest' });
        const r = runScript(configDir, `
          import { setPersistedUiLanguage } from '${PREFS_MODULE}';
          setPersistedUiLanguage('ru');
        `);
        expect(r.exitCode).toBe(0);
        const raw = JSON.parse(readFileSync(prefsFile, 'utf-8'));
        expect(raw.name).toBe('Alice');
        expect(raw.timezone).toBe('Europe/Budapest');
        expect(raw.uiLanguage).toBe('ru');
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  describe('resolveTitleLanguageName', () => {
    it('returns undefined when no UI language is persisted (so titles auto-detect)', () => {
      const { configDir } = setupDir();
      try {
        const r = runScript(configDir, `
          import { resolveTitleLanguageName } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: resolveTitleLanguageName() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: null });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('maps a persisted code to its native language name', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { uiLanguage: 'ru' });
        const r = runScript(configDir, `
          import { resolveTitleLanguageName } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: resolveTitleLanguageName() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: 'Русский' });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('resolves the Russian native name (the #885 motivating case)', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { uiLanguage: 'ru' });
        const r = runScript(configDir, `
          import { resolveTitleLanguageName } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: resolveTitleLanguageName() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: 'Русский' });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('honors an explicit English UI language (returns "English", not auto-detect)', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { uiLanguage: 'en' });
        const r = runScript(configDir, `
          import { resolveTitleLanguageName } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: resolveTitleLanguageName() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: 'English' });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('returns undefined for an unsupported persisted code', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { uiLanguage: 'xx' });
        const r = runScript(configDir, `
          import { resolveTitleLanguageName } from '${PREFS_MODULE}';
          console.log(JSON.stringify({ value: resolveTitleLanguageName() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: null });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  describe('legacy `language` field scrubbing', () => {
    it('loadPreferences strips legacy free-text language on read', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { name: 'Alice', language: 'Hungarian' });
        const r = runScript(configDir, `
          import { loadPreferences } from '${PREFS_MODULE}';
          console.log(JSON.stringify(loadPreferences()));
        `);
        expect(r.exitCode).toBe(0);
        const prefs = JSON.parse(r.stdout);
        expect(prefs).not.toHaveProperty('language');
        expect(prefs.name).toBe('Alice');
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('the next write drops the legacy language field from disk', () => {
      const { configDir, prefsFile } = setupDir();
      try {
        writeRawPrefs(prefsFile, { name: 'Alice', language: 'Hungarian' });
        const r = runScript(configDir, `
          import { setPersistedUiLanguage } from '${PREFS_MODULE}';
          setPersistedUiLanguage('ru');
        `);
        expect(r.exitCode).toBe(0);
        const raw = JSON.parse(readFileSync(prefsFile, 'utf-8'));
        expect(raw).not.toHaveProperty('language');
        expect(raw.uiLanguage).toBe('ru');
        expect(raw.name).toBe('Alice');
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });
});

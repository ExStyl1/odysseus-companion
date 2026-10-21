/**
 * P6.390(2) — `autoMemoryDirectory` and `plansDirectory`, the two settings keys
 * this fork read from nowhere.
 *
 * Both rules are taken from the shipped `claude` bundle and from
 * `settings-reference.md`, and they are DIFFERENT rules: one is an absolute or
 * `~/`-prefixed path outside the project, the other is project-root-relative and
 * discarded when it escapes. Testing them as if they were one key is how a
 * mechanical "both are directory settings" implementation would go wrong.
 *
 * The last describe is the ENVELOPE arm, and it is the reason this file grew a
 * subprocess: `StoredConfigTopLevelSchema` is `.strict()` and `loadStoredConfig`
 * THROWS `UnsupportedStorageLayoutError` on a failed parse, so between
 * `3dca12dd8` (the getters) and `config/validators.ts` learning the two names, a
 * user who followed `settings-reference.md` and wrote either key lost EVERY
 * setting in `config.json` rather than gaining one. Only a disk round-trip
 * through the production loader can prove the envelope accepts a key — an
 * in-process schema unit test passes while the app bricks — which is the same
 * reasoning `instruction-excludes-envelope.test.ts` records for its own pair.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  getAutoMemoryDirectory,
  parseAutoMemoryDirectory,
  resolvePlansDirectory,
  resolvePlansDirectoryIn,
} from '../storage.ts';

describe('autoMemoryDirectory', () => {
  it('takes an absolute path and expands a leading tilde', () => {
    // `settings-reference.md#automemorydirectory` — "string, an absolute or
    // `~/`-prefixed directory path".
    expect(parseAutoMemoryDirectory('/srv/nessy/memories')).toBe('/srv/nessy/memories');
    expect(parseAutoMemoryDirectory('~/my-memory-dir')).toBe(join(homedir(), 'my-memory-dir'));
    expect(parseAutoMemoryDirectory('  /srv/nessy/memories  ')).toBe('/srv/nessy/memories');
  });

  it('refuses each of the four shapes the bundle refuses', () => {
    // Relative — the failure this key must not have: the store would follow the
    // process's working directory from chat to chat.
    expect(() => parseAutoMemoryDirectory('memories')).toThrow(/absolute/);
    // Under three characters, and a bare Windows drive.
    expect(() => parseAutoMemoryDirectory('/a')).toThrow(/absolute/);
    expect(() => parseAutoMemoryDirectory('C:')).toThrow(/absolute/);
    // A NUL byte, written as an escape so this file stays greppable.
    expect(() => parseAutoMemoryDirectory('/srv/\u0000/memories')).toThrow(/NUL/);
    // And the non-strings, which arrive from a hand-edited JSON file.
    expect(() => parseAutoMemoryDirectory('')).toThrow(/non-empty string/);
    expect(() => parseAutoMemoryDirectory(42)).toThrow(/non-empty string/);
  });

  it('is unset today, so nothing moves for anyone who set nothing', () => {
    expect(getAutoMemoryDirectory()).toBeUndefined();
  });
});

describe('plansDirectory', () => {
  const root = `${sep}work${sep}repo`;

  it('resolves relative to the project root', () => {
    // `settings-reference.md#plansdirectory` — "string, a path relative to the
    // project root"; the page's own example is `./plans`.
    expect(resolvePlansDirectoryIn(root, './plans')).toBe(join(root, 'plans'));
    expect(resolvePlansDirectoryIn(root, 'docs/plans')).toBe(join(root, 'docs', 'plans'));
    // The root itself is inside the root.
    expect(resolvePlansDirectoryIn(root, '.')).toBe(root);
  });

  it('keeps the default when the path resolves outside the project root', () => {
    // The bundle's own message, verbatim — "plansDirectory must be within
    // project root: <value>" — and its own posture: fall back, never throw at
    // the caller, so a settings typo cannot stop a session writing a plan.
    expect(() => resolvePlansDirectoryIn(root, '../elsewhere'))
      .toThrow('plansDirectory must be within project root: ../elsewhere');
    // An ABSOLUTE value is the trap that separates this key from
    // `autoMemoryDirectory`: legal there, discarded here.
    expect(() => resolvePlansDirectoryIn(root, `${sep}tmp${sep}plans`)).toThrow(/within project root/);
    // A sibling whose name merely starts with the root's name is outside it.
    expect(() => resolvePlansDirectoryIn(root, '../repo-backup')).toThrow(/within project root/);
    expect(() => resolvePlansDirectoryIn(root, '')).toThrow(/non-empty string/);
  });

  it('is unset today, and says nothing at all without a project root', () => {
    expect(resolvePlansDirectory(root)).toBeUndefined();
    expect(resolvePlansDirectory(undefined)).toBeUndefined();
  });
});

/**
 * The envelope, driven through the production loader in a subprocess.
 *
 * `NESSY_CONFIG_DIR` is exported BEFORE bun starts, which is the only form that
 * isolates: the root `bunfig.toml`'s own top-level preload runs ahead of any CLI
 * `--preload`, so a rig that sets the variable after start freezes `CONFIG_DIR`
 * at the real `~/.nessy-agent` while still reporting the temp directory
 * (AGENTS.md §Traps).
 */
const STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;

/**
 * 60 s for the reason `instruction-excludes-envelope.test.ts` measured: under
 * concurrent lane load a subprocess import of this module graph has been seen to
 * block for tens of seconds while burning half a second of CPU, so bun's 5000 ms
 * default sits below the suite's own resting runtime. The budget is set against
 * the measured floor, not at zero.
 */
const SUBPROCESS_BUDGET_MS = 60_000;

function configDirWith(prefix: string, config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...config,
  }), 'utf-8');
  return dir;
}

function run(configDir: string, source: string): { stdout: string; stderr: string; exitCode: number } {
  const spawned = Bun.spawnSync([process.execPath, '--eval', source], {
    env: { ...process.env, NESSY_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: spawned.stdout.toString().trim(),
    stderr: spawned.stderr.toString(),
    exitCode: spawned.exitCode ?? -1,
  };
}

describe('the strict envelope declares both keys (P6.390(2))', () => {
  it('loads a config.json carrying both, with every other setting intact', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'nessy-dirs-project-'));
    const configDir = configDirWith('nessy-dirs-declared-', {
      autoMemoryDirectory: '/srv/nessy/memories',
      plansDirectory: 'docs/plans',
      // The neighbours whose loss was the actual damage of the undeclared key.
      colorTheme: 'nord',
      memoryEnabled: false,
      retentionDays: 30,
    });

    const result = run(configDir, `
      import { loadStoredConfig, getAutoMemoryDirectory, resolvePlansDirectory } from '${STORAGE_MODULE}';
      const config = loadStoredConfig();
      console.log(JSON.stringify({
        theme: config?.colorTheme ?? null,
        memoryEnabled: config?.memoryEnabled ?? null,
        retentionDays: config?.retentionDays ?? null,
        activeWorkspaceId: config?.activeWorkspaceId ?? null,
        memoryDirectory: getAutoMemoryDirectory() ?? null,
        plans: resolvePlansDirectory(${JSON.stringify(projectRoot)}) ?? null,
      }));
    `);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      theme: 'nord',
      memoryEnabled: false,
      retentionDays: 30,
      activeWorkspaceId: null,
      // Declared AND read: the getters landed in `3dca12dd8` and only ever saw
      // `undefined` until the envelope learned the names.
      memoryDirectory: '/srv/nessy/memories',
      plans: join(projectRoot, 'docs', 'plans'),
    });
  }, SUBPROCESS_BUDGET_MS);

  it('still refuses an undeclared top-level key, which is the control', () => {
    // The declaration is two names, not a loosened envelope: `.strict()` is what
    // makes an unknown key a loud failure instead of a silently ignored setting,
    // and this asserts the pair did not buy their acceptance with everyone's.
    const configDir = configDirWith('nessy-dirs-control-', {
      autoMemoryDirectory: '/srv/nessy/memories',
      plansDirectoryy: 'docs/plans',
    });

    const result = run(configDir, `
      import { loadStoredConfig } from '${STORAGE_MODULE}';
      try {
        loadStoredConfig();
        console.log(JSON.stringify({ threw: null }));
      } catch (error) {
        console.log(JSON.stringify({ threw: error?.name ?? String(error) }));
      }
    `);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ threw: 'UnsupportedStorageLayoutError' });
  }, SUBPROCESS_BUDGET_MS);
});

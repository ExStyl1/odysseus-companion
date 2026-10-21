import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import './paths-env.isolated.ts';
import './paths-security-env.isolated.ts';

const PATHS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'paths.ts')).href;

function run(configRoot: string, script: string) {
  return Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...process.env, NESSY_CONFIG_DIR: configRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function createConfigRoot(): string {
  return mkdtempSync(join(tmpdir(), 'nessy-managed-paths-'));
}

describe('managed workspace paths', () => {
  it('derives contained workspace and session paths and rejects untrusted IDs', () => {
    const configRoot = createConfigRoot();
    try {
      const result = run(configRoot, `
        import {
          CONFIG_DIR,
          WORKSPACES_DIR,
          SESSIONS_DIR,
          PLUGINS_DIR,
          RECENT_PROJECTS_PATH,
          getWorkspaceRootPath,
          getWorkspaceSessionRootPath,
          getSessionStoragePath,
          assertStorageId,
        } from '${PATHS_MODULE}';
        const invalid = ['', '.', '..', '../escape', '/tmp/escape', 'a/b', 'a\\\\b', 'nul\\0id'];
        const rejected = invalid.every(value => {
          try {
            assertStorageId('workspace', value);
            return false;
          } catch {
            return true;
          }
        });
        console.log(JSON.stringify({
          config: CONFIG_DIR,
          workspaces: WORKSPACES_DIR,
          sessions: SESSIONS_DIR,
          plugins: PLUGINS_DIR,
          recentProjects: RECENT_PROJECTS_PATH,
          workspace: getWorkspaceRootPath('ws_01'),
          sessionRoot: getWorkspaceSessionRootPath('ws_01'),
          session: getSessionStoragePath('ws_01', 'session.01'),
          legacyWorkspace: getWorkspaceRootPath('..legacy'),
          legacySession: getSessionStoragePath('..legacy', '..session'),
          legacySessionRoot: getWorkspaceSessionRootPath('..legacy'),
          legacyAccepted: assertStorageId('workspace', '..legacy'),
          rejected,
        }));
      `);

      expect(result.exitCode).toBe(0);
      const paths = JSON.parse(result.stdout.toString());
      expect(paths).toEqual({
        config: configRoot,
        workspaces: join(configRoot, 'workspaces'),
        sessions: join(configRoot, 'sessions'),
        plugins: join(configRoot, 'plugins'),
        recentProjects: join(configRoot, 'recent-projects.json'),
        workspace: join(configRoot, 'workspaces', 'ws_01'),
        sessionRoot: join(configRoot, 'sessions', 'ws_01'),
        session: join(configRoot, 'sessions', 'ws_01', 'session.01'),
        legacyWorkspace: join(configRoot, 'workspaces', '..legacy'),
        legacySession: join(configRoot, 'sessions', '..legacy', '..session'),
        legacySessionRoot: join(configRoot, 'sessions', '..legacy'),
        legacyAccepted: '..legacy',
        rejected: true,
      });
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it('rejects a pre-existing symlink that escapes the managed root', () => {
    if (process.platform === 'win32') return;

    const configRoot = createConfigRoot();
    try {
      const workspacesDir = join(configRoot, 'workspaces');
      const outside = join(configRoot, 'outside');
      mkdirSync(workspacesDir, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(workspacesDir, 'escape'), 'dir');

      const result = run(configRoot, `
        import { getWorkspaceRootPath } from '${PATHS_MODULE}';
        try {
          getWorkspaceRootPath('escape');
          process.exit(1);
        } catch {
          process.exit(0);
        }
      `);

      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it('keeps plugin cache and data paths contained with a version-less stable key and flat cache ref', () => {
    const configRoot = createConfigRoot();
    try {
      const result = run(configRoot, `
        import {
          PLUGIN_CACHE_DIR,
          PLUGIN_DATA_DIR,
          pluginKeyFor,
          encodePluginStorageKey,
          getPluginCachePath,
          getPluginDataRoot,
        } from '${PATHS_MODULE}';
        const pluginKey = pluginKeyFor('../market', 'tool/kit');
        const ref = { marketplaceId: '../market', pluginId: 'tool/kit', version: '1.2.3', bundleHash: 'a'.repeat(64) };
        let invalidHashRejected = false;
        try { getPluginCachePath({ ...ref, bundleHash: 'A'.repeat(64) }); } catch { invalidHashRejected = true; }
        console.log(JSON.stringify({
          cacheRoot: PLUGIN_CACHE_DIR,
          dataRoot: PLUGIN_DATA_DIR,
          cache: getPluginCachePath(ref),
          cacheNextVersion: getPluginCachePath({ ...ref, version: '2.0.0' }),
          data: getPluginDataRoot(pluginKey),
          // The data root is version-less: a version bump must not move it.
          dataAfterUpgrade: getPluginDataRoot(pluginKeyFor('../market', 'tool/kit')),
          sameKey: pluginKey,
          differentKey: pluginKeyFor('../market', 'tool-kit'),
          dataSegment: encodePluginStorageKey(pluginKey),
          invalidHashRejected,
        }));
      `);

      expect(result.exitCode).toBe(0);
      const paths = JSON.parse(result.stdout.toString());
      expect(paths.cacheRoot).toBe(join(configRoot, 'plugins', 'cache'));
      expect(paths.dataRoot).toBe(join(configRoot, 'plugins', 'data'));
      expect(paths.cache.startsWith(paths.cacheRoot)).toBe(true);
      expect(paths.data.startsWith(paths.dataRoot)).toBe(true);
      expect(paths.cache.endsWith(`/${'a'.repeat(64)}`)).toBe(true);
      // Cache is content-addressed by version + bundle hash; data is stable.
      expect(paths.cacheNextVersion).not.toBe(paths.cache);
      expect(paths.data).toBe(paths.dataAfterUpgrade);
      expect(paths.cache).not.toContain('../');
      expect(paths.data).not.toContain('../');
      expect(paths.sameKey).not.toBe(paths.differentKey);
      // The stable key is a single collision-free path segment (no separators).
      expect(paths.dataSegment).not.toContain('/');
      expect(Buffer.from(paths.dataSegment, 'base64url').toString('utf8')).toBe(paths.sameKey);
      expect(paths.invalidHashRejected).toBe(true);
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it('does not expose legacy config path portability tokens', () => {
    const configRoot = createConfigRoot();
    try {
      const result = run(configRoot, `
        import * as paths from '${PATHS_MODULE}';
        console.log(JSON.stringify({
          migrations: 'STORAGE_MIGRATIONS_DIR' in paths,
          token: 'CONFIG_PATH_TOKEN' in paths,
          portable: 'makeConfigPathPortable' in paths,
          expand: 'expandConfigPath' in paths,
        }));
      `);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        migrations: false,
        token: false,
        portable: false,
        expand: false,
      });
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });
});

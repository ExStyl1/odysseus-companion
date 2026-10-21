import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PATHS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'paths.ts')).href;
const STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;
const PLUGIN_STORE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'plugins', 'marketplace-registry-store.ts')).href;

describe('managed paths with NESSY_CONFIG_DIR', () => {
  it('classifies only an unset override as the canonical default root', () => {
    const profile = mkdtempSync(join(tmpdir(), 'nessy-default-profile-'));
    const customRoot = join(profile, 'custom-root');
    try {
      const defaultEnv: Record<string, string | undefined> = { ...process.env, HOME: profile, USERPROFILE: profile };
      delete defaultEnv.NESSY_CONFIG_DIR;
      // The unset-override arm is the whole point here, so the isolation has to
      // come from the disposable HOME above rather than from NESSY_CONFIG_DIR.
      // `bun test` sets NODE_ENV=test in THIS process and the child inherits it,
      // which makes config/paths.ts read the probe as a test runner resolving
      // the real ~/.nessy-agent and throw. Drop the inherited claim; the guard
      // itself is untouched and still fires for an actual `bun test` process.
      delete defaultEnv.NODE_ENV;
      const defaultResult = Bun.spawnSync([process.execPath, '--eval', `
        import { CONFIG_DIR, DEFAULT_CONFIG_DIR, IS_DEFAULT_CONFIG_DIR } from '${PATHS_MODULE}';
        console.log(JSON.stringify({ config: CONFIG_DIR, default: DEFAULT_CONFIG_DIR, isDefault: IS_DEFAULT_CONFIG_DIR }));
      `], { env: defaultEnv, stdout: 'pipe', stderr: 'pipe' });
      expect(defaultResult.exitCode, defaultResult.stderr.toString()).toBe(0);
      expect(JSON.parse(defaultResult.stdout.toString())).toEqual({
        config: join(profile, '.nessy-agent'),
        default: join(profile, '.nessy-agent'),
        isDefault: true,
      });

      const customResult = Bun.spawnSync([process.execPath, '--eval', `
        import { CONFIG_DIR, DEFAULT_CONFIG_DIR, IS_DEFAULT_CONFIG_DIR } from '${PATHS_MODULE}';
        console.log(JSON.stringify({ config: CONFIG_DIR, default: DEFAULT_CONFIG_DIR, isDefault: IS_DEFAULT_CONFIG_DIR }));
      `], {
        env: { ...defaultEnv, NESSY_CONFIG_DIR: customRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(customResult.exitCode, customResult.stderr.toString()).toBe(0);
      expect(JSON.parse(customResult.stdout.toString())).toEqual({
        config: customRoot,
        default: join(profile, '.nessy-agent'),
        isDefault: false,
      });
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  }, 30_000);

  it('relocates workspace, session, and plugin roots before module import', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'nessy-managed-paths-env-'));
    try {
      const result = Bun.spawnSync([process.execPath, '--eval', `
        import { CONFIG_DIR } from '${PATHS_MODULE}';
        import { getDefaultWorkspacesDir } from '${STORAGE_MODULE}';
        import { getDefaultPluginStoreRoot } from '${PLUGIN_STORE_MODULE}';
        console.log(JSON.stringify({
          config: CONFIG_DIR,
          workspaces: getDefaultWorkspacesDir(),
          plugins: getDefaultPluginStoreRoot(),
        }));
      `], {
        env: { ...process.env, NESSY_CONFIG_DIR: configRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        config: configRoot,
        workspaces: join(configRoot, 'workspaces'),
        plugins: join(configRoot, 'plugins'),
      });
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

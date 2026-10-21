import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolvePluginNodeRuntime, resolveWindowsSandboxRuntime } from '../internal/runtime-resolver.ts';
import { relatchHomeDirForTests } from '../../../config/home-latch.ts';

const NEUTRAL_BUN_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null';

describe('resolvePluginNodeRuntime', () => {
  const tmpBase = join(tmpdir(), `plugin-node-runtime-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('prefers the bundled Bun executable without consulting PATH', () => {
    const appRoot = join(tmpBase, 'app');
    const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const bunBase = process.platform === 'win32' ? join(tmpBase, 'resources') : appRoot;
    const bunPath = join(bunBase, 'vendor', 'bun', bunName);
    mkdirSync(join(bunBase, 'vendor', 'bun'), { recursive: true });
    writeFileSync(bunPath, 'stub');

    const shimName = process.platform === 'win32' ? 'node.cmd' : 'node';
    const shimPath = join(appRoot, 'resources', 'bin', shimName);
    mkdirSync(join(appRoot, 'resources', 'bin'), { recursive: true });
    writeFileSync(shimPath, 'shim');

    expect(resolvePluginNodeRuntime({
      appRootPath: appRoot,
      resourcesPath: bunBase,
      isPackaged: true,
    })).toMatchObject({
      command: realpathSync(bunPath),
      nodeShimDirectory: realpathSync(join(appRoot, 'resources', 'bin')),
    });
  });

  it('binds packaged Bun and uv tools from resources, never app.asar or PATH', () => {
    const appRoot = join(tmpBase, 'resources', 'app.asar');
    const resourcesRoot = join(tmpBase, 'resources');
    const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const uvName = process.platform === 'win32' ? 'uv.exe' : 'uv';
    const bunPath = join(resourcesRoot, 'vendor', 'bun', bunName);
    const uvPath = join(resourcesRoot, 'bin', uvName);
    mkdirSync(join(resourcesRoot, 'vendor', 'bun'), { recursive: true });
    mkdirSync(join(resourcesRoot, 'bin'), { recursive: true });
    writeFileSync(bunPath, 'stub');
    writeFileSync(uvPath, 'stub');
    const caPath = join(tmpBase, 'corporate-ca.pem');
    writeFileSync(caPath, 'test-ca');
    const previousUv = process.env.NESSY_UV;
    const previousCa = process.env.NODE_EXTRA_CA_CERTS;
    process.env.NESSY_UV = uvPath;
    process.env.NODE_EXTRA_CA_CERTS = caPath;
    try {
      expect(resolvePluginNodeRuntime({
        appRootPath: appRoot,
        resourcesPath: resourcesRoot,
        isPackaged: true,
      })).toMatchObject({
        command: realpathSync(bunPath),
        executables: {
          bunx: {
            command: realpathSync(bunPath),
            args: ['--no-env-file', `--config=${NEUTRAL_BUN_CONFIG}`],
            environment: {
              BUN_INSTALL_CACHE_DIR: '${NESSY_PLUGIN_DATA}/bun/cache',
              BUN_RUNTIME_TRANSPILER_CACHE_PATH: '${NESSY_PLUGIN_DATA}/bun/runtime-cache',
              HOME: '${NESSY_PLUGIN_DATA}/home',
              USERPROFILE: '${NESSY_PLUGIN_DATA}/home',
              XDG_CONFIG_HOME: '${NESSY_PLUGIN_DATA}/config',
              XDG_CACHE_HOME: '${NESSY_PLUGIN_DATA}/cache',
              XDG_DATA_HOME: '${NESSY_PLUGIN_DATA}/data',
              APPDATA: '${NESSY_PLUGIN_DATA}/app-data',
              LOCALAPPDATA: '${NESSY_PLUGIN_DATA}/local-app-data',
              NODE_EXTRA_CA_CERTS: realpathSync(caPath),
            },
          },
          uvx: {
            command: realpathSync(uvPath),
            args: ['tool', 'run'],
            environment: {
              UV_CACHE_DIR: '${NESSY_PLUGIN_DATA}/uv/cache',
              UV_TOOL_DIR: '${NESSY_PLUGIN_DATA}/uv/tools',
              UV_TOOL_BIN_DIR: '${NESSY_PLUGIN_DATA}/uv/bin',
              UV_PYTHON_INSTALL_DIR: '${NESSY_PLUGIN_DATA}/uv/python',
              // P6.1107: uv verifies against the platform certificate store, so a
              // TLS-intercepting corporate proxy does not break every PyPI resolve.
              UV_NATIVE_TLS: '1',
            },
          },
          python: {
            command: realpathSync(uvPath),
            args: ['run', '--no-project', '--python', '3.12', 'python'],
            environment: { UV_NATIVE_TLS: '1' },
          },
        },
      });
    } finally {
      if (previousUv === undefined) delete process.env.NESSY_UV;
      else process.env.NESSY_UV = previousUv;
      if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = previousCa;
    }
  });

  it('binds repository-local Bun and uv in development without PATH or env hints', () => {
    const appRoot = join(tmpBase, 'repo');
    const platformKey = `${process.platform}-${process.arch}`;
    const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const uvName = process.platform === 'win32' ? 'uv.exe' : 'uv';
    const bunPath = join(appRoot, 'apps', 'electron', 'vendor', 'bun', bunName);
    const uvPath = join(appRoot, 'apps', 'electron', 'resources', 'bin', platformKey, uvName);
    mkdirSync(join(appRoot, 'apps', 'electron', 'vendor', 'bun'), { recursive: true });
    mkdirSync(join(appRoot, 'apps', 'electron', 'resources', 'bin', platformKey), { recursive: true });
    writeFileSync(bunPath, 'stub');
    writeFileSync(uvPath, 'stub');
    const previousUv = process.env.NESSY_UV;
    delete process.env.NESSY_UV;
    try {
      expect(resolvePluginNodeRuntime({ appRootPath: appRoot, isPackaged: false })).toMatchObject({
        command: realpathSync(bunPath),
        executables: {
          bunx: {
            command: realpathSync(bunPath),
            args: ['--no-env-file', `--config=${NEUTRAL_BUN_CONFIG}`],
            environment: {
              BUN_INSTALL_CACHE_DIR: '${NESSY_PLUGIN_DATA}/bun/cache',
              HOME: '${NESSY_PLUGIN_DATA}/home',
            },
          },
          uvx: { command: realpathSync(uvPath), args: ['tool', 'run'] },
          python: { command: realpathSync(uvPath) },
        },
      });
    } finally {
      if (previousUv === undefined) delete process.env.NESSY_UV;
      else process.env.NESSY_UV = previousUv;
    }
  });

  it('ignores a plugin-authored bunfig preload when running an exact script', () => {
    if (!process.versions.bun) return;
    const bundleRoot = join(tmpBase, 'bunfig-bundle');
    const mainPath = join(bundleRoot, 'main.ts');
    mkdirSync(bundleRoot, { recursive: true });
    writeFileSync(join(bundleRoot, 'preload.ts'), 'console.log("PLUGIN_PRELOAD")\n');
    writeFileSync(join(bundleRoot, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
    writeFileSync(mainPath, 'console.log("MAIN")\n');
    const binding = resolvePluginNodeRuntime({
      appRootPath: tmpBase,
      isPackaged: false,
      nodeRuntimePath: process.execPath,
    })?.executables?.bunx;
    if (!binding) throw new Error('Bun binding unavailable');

    const result = spawnSync(binding.command, [...(binding.args ?? []), mainPath], {
      cwd: bundleRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('MAIN\n');
    expect(result.stderr).toBe('');
  });

  it('rejects an invalid explicit runtime instead of falling back to PATH', () => {
    expect(resolvePluginNodeRuntime({
      appRootPath: tmpBase,
      isPackaged: true,
      nodeRuntimePath: 'node',
    })).toBeUndefined();
  });

  it('resolves all host-owned Windows sandbox executables as one atomic binding', () => {
    const appRoot = join(tmpBase, 'app');
    const runtimeRoot = join(appRoot, 'resources', 'bin', 'codex', 'win32-x64');
    mkdirSync(runtimeRoot, { recursive: true });
    for (const name of ['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']) {
      writeFileSync(join(runtimeRoot, name), 'verified-stub');
    }

    expect(resolveWindowsSandboxRuntime({
      appRootPath: appRoot,
      isPackaged: true,
    }, 'win32', 'x64')).toEqual({
      command: realpathSync(join(runtimeRoot, 'codex.exe')),
      commandRunner: realpathSync(join(runtimeRoot, 'codex-command-runner.exe')),
      setupCommand: realpathSync(join(runtimeRoot, 'codex-windows-sandbox-setup.exe')),
    });
  });

  it('fails closed when any Windows sandbox companion executable is absent', () => {
    const appRoot = join(tmpBase, 'app');
    const runtimeRoot = join(appRoot, 'resources', 'bin', 'codex', 'win32-x64');
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, 'codex.exe'), 'incomplete-stub');

    expect(resolveWindowsSandboxRuntime({
      appRootPath: appRoot,
      isPackaged: true,
    }, 'win32', 'x64')).toBeUndefined();
  });

  it('canonicalizes the existing host-owned dp executable into an absolute binding', () => {
    if (process.platform === 'win32') return;
    const binDir = join(tmpBase, 'bin');
    const dpPath = join(binDir, 'dp');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(dpPath, '#!/bin/sh\nexit 0\n');
    chmodSync(dpPath, 0o755);
    const dpWorkdir = join(tmpBase, 'dp-state');
    mkdirSync(dpWorkdir, { recursive: true });
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    const previousDpWorkdir = process.env.DP_WORKDIR;
    process.env.PATH = binDir;
    process.env.HOME = join(tmpBase, 'read-home');
    process.env.DP_WORKDIR = dpWorkdir;
    try {
      expect(resolvePluginNodeRuntime({
        appRootPath: tmpBase,
        isPackaged: true,
        nodeRuntimePath: process.execPath,
      })).toMatchObject({
        command: process.execPath,
        executables: {
          dp: {
            command: realpathSync(dpPath),
            environment: {
              HOME: homedir(),
              DP_NO_WARNINGS: 'true',
              DP_WORKDIR: realpathSync(dpWorkdir),
            },
            writableRoots: [realpathSync(dpWorkdir)],
          },
        },
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDpWorkdir === undefined) delete process.env.DP_WORKDIR;
      else process.env.DP_WORKDIR = previousDpWorkdir;
    }
  });

  /* -------------------------------------------------------------------- *
   * DA1.49 — the dp write grant is checked against the deny floor
   * -------------------------------------------------------------------- */

  /**
   * One rig, two arms, differing ONLY in where the dp state root sits.
   *
   * The home is RELATCHED to the realpath of the fake one on purpose: the
   * credential deny floor is built from the home directory as given, while the
   * state root is realpath-canonicalised before it is compared, so a `/var/...`
   * floor against a `/private/var/...` root would miss on macOS and the arm
   * would pass for the wrong reason. In production `homedir()` is already
   * canonical, which is why this only bites a temp-directory rig.
   */
  function withDpRig(
    stateRootParts: string[],
    assertBinding: (dp: Record<string, unknown> | undefined, canonicalWorkdir: string) => void,
  ): void {
    const binDir = join(tmpBase, `deny-bin-${stateRootParts.join('-')}`);
    const dpPath = join(binDir, 'dp');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(dpPath, '#!/bin/sh\nexit 0\n');
    chmodSync(dpPath, 0o755);
    const fakeHome = join(tmpBase, `deny-home-${stateRootParts.join('-')}`);
    mkdirSync(fakeHome, { recursive: true });
    const canonicalHome = realpathSync(fakeHome);
    const workdir = join(canonicalHome, ...stateRootParts);
    mkdirSync(workdir, { recursive: true });

    const previousPath = process.env.PATH;
    const previousDpWorkdir = process.env.DP_WORKDIR;
    delete process.env.PATH;
    process.env.PATH = binDir;
    delete process.env.DP_WORKDIR;
    process.env.DP_WORKDIR = workdir;
    relatchHomeDirForTests(canonicalHome);
    try {
      const binding = resolvePluginNodeRuntime({
        appRootPath: tmpBase,
        isPackaged: true,
        nodeRuntimePath: process.execPath,
      });
      const dp = binding?.executables?.dp as unknown as Record<string, unknown> | undefined;
      // The rig itself is asserted first: an arm that found no dp at all would
      // otherwise satisfy "no write grant" for the wrong reason.
      expect(dp?.command).toBe(realpathSync(dpPath));
      expect((dp?.environment as Record<string, string> | undefined)?.DP_WORKDIR)
        .toBe(realpathSync(workdir));
      assertBinding(dp, realpathSync(workdir));
    } finally {
      relatchHomeDirForTests();
      delete process.env.PATH;
      if (previousPath !== undefined) process.env.PATH = previousPath;
      delete process.env.DP_WORKDIR;
      if (previousDpWorkdir !== undefined) process.env.DP_WORKDIR = previousDpWorkdir;
    }
  }

  it('withholds the dp write grant when the state root lies inside a denied root (DA1.49)', () => {
    if (process.platform === 'win32') return;
    // `~/.ssh` is on the credential deny floor. Seatbelt emits denies after
    // allows, so a grant here could never bind — `server-core`'s
    // `withDpStateRootWriteGrant` has refused this shape all along, and this
    // site granted it with no deny check at all until DA1.49.
    withDpRig(['.ssh', 'dp-state'], dp => {
      expect(dp?.writableRoots).toBeUndefined();
    });
  });

  it('still grants a state root that is NOT inside a denied root (DA1.49 control)', () => {
    if (process.platform === 'win32') return;
    // The same rig, the same relatched home, one path segment different. Without
    // this arm the refusal above could be the deny check refusing everything.
    withDpRig(['.dp'], (dp, canonicalWorkdir) => {
      expect(dp?.writableRoots).toEqual([canonicalWorkdir]);
    });
  });
});

/**
 * Tests for runtime-resolver.ts
 *
 * Verifies:
 * - Packaged server path resolution with dist/resources/ fallback
 * - Ripgrep path resolution with system rg fallback
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  applyAnthropicRuntimeBootstrap,
  resolveBackendRuntimePaths,
  resolvePluginNodeRuntime,
} from '../internal/runtime-resolver.ts';
import { resolveBackendHostTooling } from '../factory.ts';
import type { BackendHostRuntimeContext } from '../types.ts';

describe('resolveServerPath fallback', () => {
  const tmpBase = join(tmpdir(), `resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('finds server in dist/resources/ when resources/ does not exist', () => {
    // Simulate packaged app where server is at dist/resources/<name>/index.js
    const appRoot = join(tmpBase, 'app');
    const serverDir = join(appRoot, 'dist', 'resources', 'pi-agent-server');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'index.js'), '// stub');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.piServerPath).toBe(join(serverDir, 'index.js'));
  });

  it('prefers resources/ over dist/resources/ when both exist', () => {
    const appRoot = join(tmpBase, 'app2');

    // Create both paths
    const primaryDir = join(appRoot, 'resources', 'pi-agent-server');
    const fallbackDir = join(appRoot, 'dist', 'resources', 'pi-agent-server');
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(join(primaryDir, 'index.js'), '// primary');
    writeFileSync(join(fallbackDir, 'index.js'), '// fallback');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.piServerPath).toBe(join(primaryDir, 'index.js'));
  });
});

describe('resolveCodexBinaryPath', () => {
  const tmpBase = join(tmpdir(), `codex-resolver-test-${Date.now()}`);
  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('resolves the bundled codex-app-server for the host platform (packaged)', () => {
    const appRoot = join(tmpBase, 'app');
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
    const dir = `${process.platform}-${arch}`;
    const name = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
    const codexDir = join(appRoot, 'resources', 'bin', 'codex', dir);
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, name), '// codex stub');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };
    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.codexBinaryPath).toBe(join(codexDir, name));
  });

  it('returns undefined when the codex binary is absent', () => {
    const appRoot = join(tmpBase, 'empty');
    mkdirSync(appRoot, { recursive: true });
    const hostRuntime: BackendHostRuntimeContext = { appRootPath: appRoot, resourcesPath: appRoot, isPackaged: true };
    expect(resolveBackendRuntimePaths(hostRuntime).codexBinaryPath).toBeUndefined();
  });
});

describe('resolveRipgrepPath', () => {
  const tmpBase = join(tmpdir(), `rg-resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('finds vendored ripgrep binary (@vscode/ripgrep)', () => {
    const appRoot = join(tmpBase, 'vendored');
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const rgDir = join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin');
    mkdirSync(rgDir, { recursive: true });
    const rgPath = join(rgDir, binaryName);
    writeFileSync(rgPath, '#!/bin/sh\n');
    chmodSync(rgPath, 0o755);

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    expect(result.ripgrepPath).toBe(rgPath);
  });

  /**
   * F1.746 — `@vscode/ripgrep` ≥1.17 ships the binary only in its per-platform optional package (what the package's own
   * `rgPath` resolves); `ripgrep/bin/rg` exists only as an old-layout leftover, never on a fresh checkout.
   */
  function plantRg(appRoot: string, packageDir: string): string {
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const rgDir = join(appRoot, 'node_modules', '@vscode', packageDir, 'bin');
    mkdirSync(rgDir, { recursive: true });
    const rgPath = join(rgDir, binaryName);
    writeFileSync(rgPath, '#!/bin/sh\n');
    chmodSync(rgPath, 0o755);
    return rgPath;
  }

  it('F1.746: a fresh-checkout tree (no ripgrep/bin) resolves the per-platform package', () => {
    const appRoot = join(tmpBase, 'fresh');
    const platformRg = plantRg(appRoot, `ripgrep-${process.platform}-${process.arch}`);
    mkdirSync(join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'lib'), { recursive: true });
    const result = resolveBackendHostTooling({ hostRuntime: { appRootPath: appRoot, resourcesPath: appRoot, isPackaged: false } });
    expect(result.ripgrepPath).toBe(platformRg);
  });

  it('F1.746: the per-platform package wins over an old-layout ripgrep/bin leftover', () => {
    const appRoot = join(tmpBase, 'leftover');
    plantRg(appRoot, 'ripgrep');
    const platformRg = plantRg(appRoot, `ripgrep-${process.platform}-${process.arch}`);
    const result = resolveBackendHostTooling({ hostRuntime: { appRootPath: appRoot, resourcesPath: appRoot, isPackaged: false } });
    expect(result.ripgrepPath).toBe(platformRg);
  });

  it('falls back to system rg when vendored binary is missing (non-packaged)', () => {
    const appRoot = join(tmpBase, 'no-vendored');
    mkdirSync(appRoot, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    // On CI/dev machines with rg installed, this finds system rg.
    // On machines without rg, this returns undefined.
    // We just verify it doesn't throw.
    expect(result.ripgrepPath === undefined || typeof result.ripgrepPath === 'string').toBe(true);
  });

  it('does NOT fall back to system rg for packaged apps (respects isPackaged guard)', () => {
    // On dev machines, the CWD fallback (existing pre-change behavior) will find
    // the vendored binary from the monorepo. This test verifies the system PATH
    // fallback is gated by isPackaged — if the result is defined, it must be
    // a vendored path (not /usr/bin/rg or similar system path).
    const appRoot = join(tmpBase, 'packaged');
    mkdirSync(appRoot, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    if (result.ripgrepPath) {
      // Must be a vendored path, not a system PATH resolution
      expect(result.ripgrepPath).toContain('node_modules');
    }
  });
});

describe('resolveClaudeBinaryPath (native binary, SDK ≥ 0.2.113)', () => {
  const tmpBase = join(tmpdir(), `claude-bin-resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('finds the per-platform native binary in the optional-dep package', () => {
    const appRoot = join(tmpBase, 'app');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platformPkg = process.platform === 'win32'
      ? `claude-agent-sdk-win32-${arch}`
      : process.platform === 'darwin'
        ? `claude-agent-sdk-darwin-${arch}`
        : `claude-agent-sdk-linux-${arch}`;
    const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const binDir = join(appRoot, 'node_modules', '@anthropic-ai', platformPkg);
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, binaryName);
    writeFileSync(binPath, '#!/bin/sh\n');
    chmodSync(binPath, 0o755);

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.claudeCliPath).toBe(binPath);
  });

  it('returns undefined when the platform package is missing', () => {
    const appRoot = join(tmpBase, 'no-binary');
    mkdirSync(appRoot, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.claudeCliPath).toBeUndefined();
  });

  it('throws a clean disabled-Claude error when the staged alias dir is empty', () => {
    const appRoot = join(tmpBase, 'empty-alias');
    const aliasDir = join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-binary');
    mkdirSync(aliasDir, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.claudeCliPath).toBeUndefined();
    expect(() => applyAnthropicRuntimeBootstrap(hostRuntime, paths)).toThrow(
      'Claude support is not included in this build.',
    );
  });
});

describe('resolveInterceptorBundlePath dev-mode source preference', () => {
  const tmpBase = join(tmpdir(), `interceptor-resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('prefers .ts source over the bundled .cjs in dev (non-packaged) so changes propagate without rebuild', () => {
    const appRoot = join(tmpBase, 'monorepo', 'apps', 'electron');
    const sourceDir = join(tmpBase, 'monorepo', 'packages', 'shared', 'src');
    const bundleDir = join(tmpBase, 'monorepo', 'apps', 'electron', 'dist');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    const sourcePath = join(sourceDir, 'unified-network-interceptor.ts');
    const bundlePath = join(bundleDir, 'interceptor.cjs');
    writeFileSync(sourcePath, '// ts source\n');
    writeFileSync(bundlePath, '// cjs bundle\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };
    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.interceptorBundlePath).toBe(sourcePath);
  });

  it('uses the bundled .cjs in packaged builds even when source is reachable', () => {
    const appRoot = join(tmpBase, 'packaged-app');
    const sourceDir = join(tmpBase, 'packaged-app', 'packages', 'shared', 'src');
    const bundleDir = join(tmpBase, 'packaged-app', 'dist');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(sourceDir, 'unified-network-interceptor.ts'), '// source\n');
    const bundlePath = join(bundleDir, 'interceptor.cjs');
    writeFileSync(bundlePath, '// bundle\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };
    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.interceptorBundlePath).toBe(bundlePath);
  });

  it('honors explicit hostRuntime.interceptorBundlePath override regardless of mode', () => {
    const appRoot = join(tmpBase, 'override');
    mkdirSync(appRoot, { recursive: true });
    const overridePath = join(appRoot, 'custom-interceptor.cjs');
    writeFileSync(overridePath, '// custom\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
      interceptorBundlePath: overridePath,
    };
    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.interceptorBundlePath).toBe(overridePath);
  });
});

describe('resolvePluginNodeRuntime DP binding', () => {
  const tmpBase = join(tmpdir(), `dp-runtime-resolver-test-${Date.now()}`);
  const previousPath = process.env.PATH;
  const previousWorkdir = process.env.DP_WORKDIR;

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousWorkdir === undefined) delete process.env.DP_WORKDIR;
    else process.env.DP_WORKDIR = previousWorkdir;
  });

  it('marks only the resolved host DP executable and disables subprocess login', () => {
    const binDir = join(tmpBase, 'bin');
    const dpPath = join(binDir, 'dp');
    const workdir = join(tmpBase, 'state');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    writeFileSync(dpPath, '#!/bin/sh\nexit 0\n');
    chmodSync(dpPath, 0o755);
    process.env.PATH = binDir;
    process.env.DP_WORKDIR = workdir;

    const runtime = resolvePluginNodeRuntime({
      appRootPath: tmpBase,
      isPackaged: false,
      nodeRuntimePath: process.execPath,
    });

    expect(runtime?.executables?.dp).toEqual({
      command: realpathSync(dpPath),
      environment: {
        HOME: homedir(),
        DP_NO_WARNINGS: 'true',
        DP_AI_MCP_SKIP_LOGIN: 'true',
        DP_WORKDIR: realpathSync(workdir),
      },
      writableRoots: [realpathSync(workdir)],
      externalAuthProvider: 'dp',
    });
    expect(runtime?.executables?.dp?.environment).not.toHaveProperty('GITLAB_TOKEN');
  });
});

/**
 * F1.152 — `bridge-mcp-server` is not in the bundle, and nothing resolves it.
 *
 * It was the upstream fork's MCP bridge for its Copilot backend (`applyBridgeUpdates`'
 * docblock still names "Copilot: writes bridge-config.json"); this fork has no such
 * backend. Census at `76f1cc426`: the one producer, `resolveBackendRuntimePaths`'s
 * `bridgeServerPath`, had ZERO readers on any runtime, while the 645 695-byte
 * `resources/bridge-mcp-server/index.js` shipped TWICE in every dmg — once through the
 * `electron-builder.yml` `files` entry and once through `dist/**`, because
 * `apps/electron/scripts/copy-assets.ts` copies ALL of `resources/` into
 * `dist/resources/`. So the drop is the directory itself, not only the list entry.
 */
describe('F1.152 — no bridge-mcp-server in the bundle', () => {
  const tmpBase = join(tmpdir(), `resolver-f1152-${Date.now()}`);
  afterEach(() => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

  it('the resolver publishes no bridge path, even on a packaged tree that still carries one', () => {
    // A tree built BEFORE the drop, so a stale copy cannot be picked up again.
    const appRoot = join(tmpBase, 'app');
    const stale = join(appRoot, 'resources', 'bridge-mcp-server');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'index.js'), '// stub');
    // The control: its sibling on the same resolver, same tree, still resolves.
    const session = join(appRoot, 'resources', 'session-mcp-server');
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, 'index.js'), '// stub');

    const paths = resolveBackendRuntimePaths({ appRootPath: appRoot, resourcesPath: appRoot, isPackaged: true });

    expect(paths.sessionServerPath).toBe(join(session, 'index.js'));
    expect(Object.keys(paths)).not.toContain('bridgeServerPath');
  });

  it('neither the resources tree nor the electron-builder files list carries it', () => {
    const electronRoot = join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'apps', 'electron');
    const builderFiles = readFileSync(join(electronRoot, 'electron-builder.yml'), 'utf8');
    // Controls on the same instruments: the session server is still listed, and the
    // resources directory the absence is read in is the real one.
    expect(builderFiles).toContain('- resources/session-mcp-server/**/*');
    expect(existsSync(join(electronRoot, 'resources', 'permissions'))).toBe(true);
    expect(existsSync(join(electronRoot, 'resources', 'bridge-mcp-server'))).toBe(false);
    expect(builderFiles).not.toContain('- resources/bridge-mcp-server');
  });
});

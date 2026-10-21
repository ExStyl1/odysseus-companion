import { existsSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  BackendHostRuntimeContext,
  PluginNodeRuntimeBinding,
  WindowsSandboxRuntimeBinding,
} from '../types.ts';
import { setPathToClaudeCodeExecutable } from '../../options.ts';
import { credentialDenyRoots } from '@nessy-agent/session-tools-core';
import { CONFIG_DIR } from '../../../config/paths.ts';
import { latchedHomeDir } from '../../../config/home-latch.ts';
import { resolveDpRuntime } from '../../../auth/dp/dp-binary.ts';
import {
  dpRuntimeEnvironment,
  dpStateRootDeniedBy,
  hardenDpStateRoot,
  resolveDpStateRoot,
} from '../../../auth/dp/dp-runtime.ts';
import { getPluginNetworkEnvVars } from '../../../config/proxy-env.ts';

/**
 * When set, the resolver walks further up from the .app bundle to find SDK,
 * interceptor, and bun in the monorepo / on the system PATH.
 * Intended for local `electron:dist:mac` builds that skip `build-dmg.sh`.
 */
const IS_DEV_RUNTIME = !!process.env.NESSY_DEV_RUNTIME;

export interface ResolvedBackendRuntimePaths {
  /**
   * Absolute path to the native `claude` binary (since SDK 0.2.113).
   * In packaged builds this is the per-platform binary copied out of
   * `node_modules/@anthropic-ai/claude-agent-sdk-{platform}-{arch}/`.
   * Field is named `claudeCliPath` for back-compat — semantically it is
   * the SDK executable, JS or native.
   */
  claudeCliPath?: string;
  /**
   * Source/bundle path for the network interceptor preloaded into the **Pi**
   * subprocess. Not used for Claude anymore — the new native SDK binary
   * doesn't accept `--preload`.
   */
  interceptorBundlePath?: string;
  sessionServerPath?: string;
  // F1.152: `bridgeServerPath` removed with the bridge bundle (it had no reader).
  piServerPath?: string;
  nodeRuntimePath?: string;
  pluginNodeRuntime?: PluginNodeRuntimeBinding;
  /** Pinned OpenAI restricted-token sandbox runtime used by supervised Windows plugin processes. */
  windowsSandboxRuntime?: WindowsSandboxRuntimeBinding;
  bundledRuntimePath?: string;
  /** Absolute path to the bundled `codex-app-server` binary for this platform. */
  codexBinaryPath?: string;
}

export interface ResolvedBackendHostTooling {
  ripgrepPath?: string;
}

function firstExistingPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Walk up from `base` checking `join(ancestor, relativePath)` at each level.
 * Stops after `maxLevels` ancestors or when hitting the filesystem root.
 */
function resolveUpwards(base: string, relativePath: string, maxLevels = 4): string | undefined {
  let dir = resolve(base);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return undefined;
}

function resolveBundledRuntimeFile(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  return firstExistingFile([
    ...(hostRuntime.resourcesPath ? [join(hostRuntime.resourcesPath, 'vendor', 'bun', bunBinary)] : []),
    join(hostRuntime.appRootPath, 'vendor', 'bun', bunBinary),
    join(hostRuntime.appRootPath, 'apps', 'electron', 'vendor', 'bun', bunBinary),
  ]);
}

function resolveBundledUvFile(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const uvBinary = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const platformDirectory = `${process.platform}-${process.arch}`;
  const explicit = process.env.NESSY_UV;
  return firstExistingFile([
    ...(explicit && isAbsolute(explicit) ? [explicit] : []),
    join(hostRuntime.appRootPath, 'resources', 'bin', platformDirectory, uvBinary),
    join(hostRuntime.appRootPath, 'apps', 'electron', 'resources', 'bin', platformDirectory, uvBinary),
    join(hostRuntime.appRootPath, 'resources', 'bin', uvBinary),
    ...(hostRuntime.resourcesPath
      ? [
          join(hostRuntime.resourcesPath, 'app', 'resources', 'bin', platformDirectory, uvBinary),
          join(hostRuntime.resourcesPath, 'resources', 'bin', platformDirectory, uvBinary),
          join(hostRuntime.resourcesPath, 'bin', uvBinary),
        ]
      : []),
  ]);
}

function resolveBundledRuntimePath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const bundled = resolveBundledRuntimeFile(hostRuntime);
  if (bundled) return bundled;

  // Non-packaged (headless server, dev mode): fall back to system bun via PATH.
  // Packaged apps must ship their own bundled bun — never resolve from PATH
  // to avoid picking up an incompatible system install.
  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemBun = execFileSync(whichCmd, ['bun'], { encoding: 'utf-8' }).trim();
      if (systemBun && existsSync(systemBun)) return systemBun;
    } catch { /* system bun not found */ }
  }
  return undefined;
}

/**
 * Resolve the host-owned runtime used for plugin MCP manifests that declare a
 * bare `node` command. This path never consults PATH: packaged builds use the
 * bundled Bun runtime, while dev/headless hosts use their own executable.
 */
export function resolvePluginNodeRuntime(
  hostRuntime: BackendHostRuntimeContext,
): PluginNodeRuntimeBinding | undefined {
  const explicit = hostRuntime.nodeRuntimePath;
  if (explicit) {
    if (!isAbsolute(explicit) || !existsSync(explicit)) return undefined;
    return pluginNodeRuntimeBinding(realpathSync(explicit), hostRuntime);
  }

  const bundled = resolveBundledRuntimeFile(hostRuntime);
  if (bundled) return pluginNodeRuntimeBinding(bundled, hostRuntime);

  if (!isAbsolute(process.execPath) || !existsSync(process.execPath)) return undefined;
  return pluginNodeRuntimeBinding(realpathSync(process.execPath), hostRuntime);
}

/**
 * Resolve the complete Windows sandbox toolchain without consulting PATH.
 * The runner and its two companion executables must be siblings from the same
 * packaged directory; a partial/stale installation fails closed.
 */
export function resolveWindowsSandboxRuntime(
  hostRuntime: BackendHostRuntimeContext,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): WindowsSandboxRuntimeBinding | undefined {
  if (platform !== 'win32') return undefined;
  const platformArch = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : arch;
  const relativeDirectory = join('resources', 'bin', 'codex', `win32-${platformArch}`);
  const candidateDirectories = hostRuntime.isPackaged
    ? [
        join(hostRuntime.appRootPath, relativeDirectory),
        join(hostRuntime.appRootPath, 'dist', relativeDirectory),
        ...(hostRuntime.resourcesPath
          ? [join(hostRuntime.resourcesPath, 'bin', 'codex', `win32-${platformArch}`)]
          : []),
      ]
    : [
        join(hostRuntime.appRootPath, relativeDirectory),
        join(hostRuntime.appRootPath, 'apps', 'electron', relativeDirectory),
        ...(() => {
          const command = resolveUpwards(
            hostRuntime.appRootPath,
            join('apps', 'electron', relativeDirectory, 'codex.exe'),
            10,
          );
          return command ? [dirname(command)] : [];
        })(),
      ];

  for (const directory of candidateDirectories) {
    const command = join(directory, 'codex.exe');
    const commandRunner = join(directory, 'codex-command-runner.exe');
    const setupCommand = join(directory, 'codex-windows-sandbox-setup.exe');
    if (![command, commandRunner, setupCommand].every(existsSync)) continue;
    return {
      command: realpathSync(command),
      commandRunner: realpathSync(commandRunner),
      setupCommand: realpathSync(setupCommand),
    };
  }
  return undefined;
}

function pluginNodeRuntimeBinding(
  command: string,
  hostRuntime: BackendHostRuntimeContext,
): PluginNodeRuntimeBinding {
  const dp = resolvePluginDpRuntime();
  const bun = resolveBundledRuntimeFile(hostRuntime)
    ?? (basename(command) === 'bun' || basename(command) === 'bun.exe' ? command : undefined);
  const uv = resolveBundledUvFile(hostRuntime);
  // `UV_NATIVE_TLS` makes uv verify against the PLATFORM certificate store.
  // Measured on a T-Bank laptop behind the corporate TLS-intercepting proxy
  // (2026-09-11, P6.1107): `bun run test:doc-tools` fails 14 of 19 with
  // `invalid peer certificate: UnknownIssuer` raised by `uv run`, and passes
  // 19 of 19 with this variable set. Every uv resolve of PyPI is live, so a
  // python MCP plugin meets that failure the first time it needs a dependency,
  // and nothing in the app tells the user which flag would have fixed it.
  //
  // It REPLACES rather than adds. uv's own reference says the variable makes uv
  // "load TLS certificates from the platform's native certificate store instead
  // of the bundled Mozilla root certificates"
  // (https://docs.astral.sh/uv/reference/environment/, entry `UV_NATIVE_TLS`).
  // We still keep it on unconditionally: the corporate store is the shipped
  // case, and a machine whose system store lacks a public root that webpki
  // carries has a remedy the proxy case does not — install the root.
  //
  // `UV_NATIVE_TLS` and not its documented successor `UV_SYSTEM_CERTS` (same
  // page, "added in 0.11.0"), because this app stages uv 0.10.6 (`UV_VERSION`
  // in `scripts/build/common.ts`). Measured against the staged binary:
  // `UV_SYSTEM_CERTS` occurs 0 times in it and `--system-certs` is absent from
  // its `--help`, while `UV_NATIVE_TLS` occurs 3 times and `--native-tls` is in
  // the help with `[env: UV_NATIVE_TLS=]` beside it. Revisit when uv is lifted
  // past 0.11.0 — the page marks `UV_NATIVE_TLS` deprecated, not removed.
  const uvEnvironment = {
    UV_CACHE_DIR: '${NESSY_PLUGIN_DATA}/uv/cache',
    UV_TOOL_DIR: '${NESSY_PLUGIN_DATA}/uv/tools',
    UV_TOOL_BIN_DIR: '${NESSY_PLUGIN_DATA}/uv/bin',
    UV_PYTHON_INSTALL_DIR: '${NESSY_PLUGIN_DATA}/uv/python',
    UV_NATIVE_TLS: '1',
  };
  // Settings-derived CA first (custom tlsCaPath or the bundled corporate
  // resource), then the ambient process env — so plugin executables verify
  // against the same trust chain as the main process even when the app was
  // not launched from a shell that exported NODE_EXTRA_CA_CERTS.
  const extraCaFile = (getPluginNetworkEnvVars().NODE_EXTRA_CA_CERTS
    ?? process.env.NODE_EXTRA_CA_CERTS)?.trim();
  const canonicalExtraCaFile = extraCaFile && isAbsolute(extraCaFile)
    ? firstExistingFile([extraCaFile])
    : undefined;
  const neutralBunConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const nodeShimDirectory = resolvePluginNodeShimDirectory(hostRuntime);
  return {
    command,
    ...(nodeShimDirectory ? { nodeShimDirectory } : {}),
    ...(command === process.execPath && process.versions.electron
      ? { environment: { ELECTRON_RUN_AS_NODE: '1' } }
      : {}),
    ...((dp || bun || uv)
      ? {
          executables: {
            ...(dp ? { dp } : {}),
            ...(bun
              ? {
                  bunx: {
                    command: bun,
                    args: ['--no-env-file', `--config=${neutralBunConfig}`],
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
                      ...(canonicalExtraCaFile ? { NODE_EXTRA_CA_CERTS: canonicalExtraCaFile } : {}),
                    },
                  },
                }
              : {}),
            ...(uv
              ? {
                  uvx: { command: uv, args: ['tool', 'run'], environment: uvEnvironment },
                  python: {
                    command: uv,
                    args: ['run', '--no-project', '--python', '3.12', 'python'],
                    environment: uvEnvironment,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function resolvePluginNodeShimDirectory(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const shim = process.platform === 'win32' ? 'node.cmd' : 'node';
  const path = firstExistingFile([
    ...(hostRuntime.resourcesPath ? [join(hostRuntime.resourcesPath, 'bin', shim)] : []),
    join(hostRuntime.appRootPath, 'resources', 'bin', shim),
    join(hostRuntime.appRootPath, 'apps', 'electron', 'resources', 'bin', shim),
  ]);
  return path ? dirname(path) : undefined;
}

function firstExistingFile(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      const canonical = realpathSync(candidate);
      if (statSync(canonical).isFile()) return canonical;
    } catch {}
  }
  return undefined;
}

/**
 * DA1.6 item 4, landed by DA1.52 · ONE record. The binary and the state root it
 * must run against come from the same call, so this site can never pair a
 * binary chosen by one rung of the ladder with a workdir derived independently.
 *
 * Not a defect today and worth saying why, so the conversion is not mistaken
 * for a bug fix: with `~/.dp` present the two answers agree in effect — the old
 * `resolveDpStateRoot()` returned the realpath of `~/.dp` and the record
 * returns `undefined`, and both make dp use `~/.dp`. Since F1.363 the record
 * answers `undefined` with NO `~/.dp` too (dp makes its own on first login), so
 * the two agree everywhere unless `DP_WORKDIR` is set.
 *
 * `resolveDpRuntime` throws `DpNotFound` when no rung is runnable, which is the
 * same throw `resolveDpBinary()` made here before; the surrounding catch is
 * what turns it into "no dp executable to offer", unchanged.
 *
 * **THE HAND-OFF'S ONE-LINE FORM WAS NOT SAFE HERE, and this is the correction.**
 * It proposed `const stateRoot = runtime.workdir`, which is right at the sibling
 * site (`mcp/builtin-dp-servers.ts`, where the value only becomes `DP_WORKDIR`
 * for dp itself) and wrong here, where the SAME value also becomes a sandbox
 * `writableRoots` grant. The record's workdir is `resolve()`d and nothing more;
 * `resolveDpStateRoot`'s four refusals exist for this call site by name — its
 * own docblock calls them "deliberate hardening over the pre-extraction plugin
 * path", and the plugin path is this one. Dropping them would have
 * de-canonicalised the grant (`plugin-node-runtime.test.ts` caught exactly that:
 * a `/var/...` grant against a child writing through `/private/var/...`) and
 * would have let an operator's `DP_WORKDIR=$HOME` become a whole-home write
 * grant. So the record chooses the rung and {@link hardenDpStateRoot} decides
 * whether what it chose may be granted.
 *
 * And the `undefined` branch is not "no state root": it means dp falls back to
 * its OWN `~/.dp`, which is still the directory dp REFRESHES ITS TOKEN INTO and
 * therefore still the directory the sandbox must grant. Taking the record's
 * `undefined` literally would have removed that grant in the dominant case —
 * the machine that HAS a `~/.dp`.
 */
function resolvePluginDpRuntime(): NonNullable<PluginNodeRuntimeBinding['executables']>[string] | undefined {
  try {
    const runtime = resolveDpRuntime();
    if (!isAbsolute(runtime.dpPath) || !existsSync(runtime.dpPath)) return undefined;
    const command = realpathSync(runtime.dpPath);
    const stateRoot = runtime.workdir === undefined
      ? resolveDpStateRoot()
      : hardenDpStateRoot(runtime.workdir);
    // DA1.49 · the deny floor, which this grant used to ignore entirely. The
    // ENVIRONMENT still carries `DP_WORKDIR` either way — dp writes there
    // whatever the sandbox says, and telling it a different root would be a
    // second bug — but the WRITE GRANT is withheld when the root lies inside a
    // denied one, exactly as `server-core`'s `withDpStateRootWriteGrant` does.
    // Seatbelt emits denies after allows, so such a grant never binds and
    // shipping it is a silent no-op.
    const denied = stateRoot
      ? dpStateRootDeniedBy(stateRoot, credentialDenyRoots(latchedHomeDir(), CONFIG_DIR))
      : undefined;
    return {
      command,
      externalAuthProvider: 'dp',
      environment: dpRuntimeEnvironment(stateRoot),
      ...(stateRoot && !denied ? { writableRoots: [stateRoot] } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Compute the per-platform optional-dependency package name shipped by the
 * Claude Agent SDK (since 0.2.113), e.g. `claude-agent-sdk-darwin-arm64`.
 *
 * NOTE on Linux musl: this returns the glibc variant. AppImage targets glibc
 * and that is the only Linux flavour we ship for the desktop app. The headless
 * server in Docker (which may run on Alpine/musl) is a separate concern —
 * track in Phase 2 when we look at server packaging.
 */
function platformBinaryPkg(): string | undefined {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `claude-agent-sdk-darwin-${arch}`;
  if (process.platform === 'win32') return `claude-agent-sdk-win32-${arch}`;
  if (process.platform === 'linux') return `claude-agent-sdk-linux-${arch}`;
  return undefined;
}

function nativeBinaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

/**
 * Resolve the per-platform native `claude` binary shipped by the SDK as an
 * optional dependency. Replaces the old `cli.js` lookup (SDK ≥ 0.2.113).
 *
 * Search order:
 *   1. Stable build alias `@anthropic-ai/claude-agent-sdk-binary` — this is
 *      what the platform build scripts (build-dmg.sh etc.) populate before
 *      electron-builder runs, so packaged builds always find the binary at a
 *      single, arch-agnostic path regardless of how it was sourced.
 *   2. Per-platform optional-dep package name (`-darwin-arm64`, etc.) —
 *      what plain `bun install` produces in dev / monorepo / CI.
 *   3. Dev-runtime walk-up across both lookups for ad-hoc local builds
 *      (`electron:dist:dev:mac`).
 */
function resolveClaudeBinaryPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const binaryName = nativeBinaryName();
  const aliasRel = join('node_modules', '@anthropic-ai', 'claude-agent-sdk-binary', binaryName);
  const pkg = platformBinaryPkg();
  const platformRel = pkg
    ? join('node_modules', '@anthropic-ai', pkg, binaryName)
    : undefined;

  const candidates: string[] = [
    join(hostRuntime.appRootPath, aliasRel),
    join(hostRuntime.appRootPath, '..', '..', aliasRel),
  ];
  if (platformRel) {
    candidates.push(
      join(hostRuntime.appRootPath, platformRel),
      join(hostRuntime.appRootPath, '..', '..', platformRel),
    );
  }

  const result = firstExistingPath(candidates);
  if (result) return result;

  // Dev runtime: walk further up from .app bundle to reach monorepo root
  if (IS_DEV_RUNTIME) {
    return resolveUpwards(hostRuntime.appRootPath, aliasRel, 10)
      ?? (platformRel ? resolveUpwards(hostRuntime.appRootPath, platformRel, 10) : undefined);
  }
  return undefined;
}

function resolveInterceptorBundlePath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  if (hostRuntime.interceptorBundlePath && existsSync(hostRuntime.interceptorBundlePath)) {
    return hostRuntime.interceptorBundlePath;
  }

  // In dev / monorepo runs, prefer the TypeScript source so changes are
  // picked up without a manual `bun run build:interceptor`. Bun handles
  // `--require <file>.ts` natively. Packaged builds always go through the
  // pre-built `dist/interceptor.cjs` bundle.
  if (!hostRuntime.isPackaged) {
    const source = resolveUpwards(
      hostRuntime.appRootPath,
      join('packages', 'shared', 'src', 'unified-network-interceptor.ts'),
      10,
    );
    if (source) return source;
  }

  return resolveUpwards(hostRuntime.appRootPath, join('dist', 'interceptor.cjs'))
    ?? resolveUpwards(hostRuntime.appRootPath, join('apps', 'electron', 'dist', 'interceptor.cjs'));
}

function resolveServerPath(hostRuntime: BackendHostRuntimeContext, serverName: string): string | undefined {
  if (hostRuntime.isPackaged) {
    return firstExistingPath([
      join(hostRuntime.appRootPath, 'resources', serverName, 'index.js'),
      join(hostRuntime.appRootPath, 'dist', 'resources', serverName, 'index.js'),
    ]);
  }
  return resolveUpwards(
    hostRuntime.appRootPath,
    join('packages', serverName, 'dist', 'index.js'),
  );
}

/**
 * Resolve the bundled `codex-app-server` binary. It ships under
 * `resources/bin/codex/<platform-dir>/` (like the `uv`/tool binaries), NOT under
 * `node_modules` — so resolution mirrors `resolveServerPath` (packaged:
 * `appRootPath/resources/...` + `dist/` + `resourcesPath` fallbacks; dev:
 * walk-up to the monorepo `apps/electron/resources/...`). The pre-spawn SHA
 * gate lives separately in `manifest-verifier.ts`.
 */
export function resolveCodexBinaryPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  const dir = `${process.platform}-${arch}`;
  const name = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
  const rel = join('resources', 'bin', 'codex', dir, name);

  if (hostRuntime.isPackaged) {
    return firstExistingPath([
      join(hostRuntime.appRootPath, rel),
      join(hostRuntime.appRootPath, 'dist', rel),
      ...(hostRuntime.resourcesPath ? [join(hostRuntime.resourcesPath, 'bin', 'codex', dir, name)] : []),
    ]);
  }
  return resolveUpwards(
    hostRuntime.appRootPath,
    join('apps', 'electron', 'resources', 'bin', 'codex', dir, name),
    10,
  );
}

/**
 * Locate ripgrep. Sourced from `@vscode/ripgrep` since SDK 0.2.113 stopped
 * shipping `vendor/ripgrep/<platform>/rg` (the binary is now compiled into
 * the native `claude` executable, but our search service in
 * `packages/server-core/src/services/search.ts` still calls it directly).
 */
function resolveRipgrepPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const ripgrepRelative = join('node_modules', '@vscode', 'ripgrep', 'bin', binaryName);

  if (hostRuntime.isPackaged) {
    const packaged = join(hostRuntime.appRootPath, ripgrepRelative);
    if (existsSync(packaged)) return packaged;
  }

  // F1.746 — `@vscode/ripgrep` ≥1.17 ships the binary only in its per-platform optional package (what the package's
  // own `rgPath` resolves), so a fresh checkout has no `ripgrep/bin/rg`; that path is an old-layout leftover, possibly
  // stale, and stays a fallback. The packaged path above is the build's staged copy (build-dmg.sh / build-linux.sh).
  const platformRelative = join('node_modules', '@vscode', `ripgrep-${process.platform}-${process.arch}`, 'bin', binaryName);
  const fromHostRoot = resolveUpwards(hostRuntime.appRootPath, platformRelative, 10)
    ?? resolveUpwards(hostRuntime.appRootPath, ripgrepRelative, 10);
  if (fromHostRoot) return fromHostRoot;

  const cwdFallback = [platformRelative, ripgrepRelative].map(relative => join(process.cwd(), relative)).find(existsSync);
  if (cwdFallback) return cwdFallback;

  // Non-packaged (headless server, dev mode): fall back to system rg via PATH.
  // Packaged apps must use vendored binary only — never resolve from PATH
  // to avoid picking up an incompatible system install.
  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemRg = execFileSync(whichCmd, ['rg'], { encoding: 'utf-8' }).trim();
      if (systemRg && existsSync(systemRg)) return systemRg;
    } catch { /* system rg not found */ }
  }

  return undefined;
}

export function resolveBackendRuntimePaths(hostRuntime: BackendHostRuntimeContext): ResolvedBackendRuntimePaths {
  const bundledRuntimePath = hostRuntime.nodeRuntimePath || resolveBundledRuntimePath(hostRuntime);

  return {
    claudeCliPath: resolveClaudeBinaryPath(hostRuntime),
    interceptorBundlePath: resolveInterceptorBundlePath(hostRuntime),
    sessionServerPath: resolveServerPath(hostRuntime, 'session-mcp-server'),
    piServerPath: resolveServerPath(hostRuntime, 'pi-agent-server'),
    nodeRuntimePath: hostRuntime.nodeRuntimePath || bundledRuntimePath || process.execPath,
    pluginNodeRuntime: resolvePluginNodeRuntime(hostRuntime),
    windowsSandboxRuntime: resolveWindowsSandboxRuntime(hostRuntime),
    bundledRuntimePath,
    codexBinaryPath: resolveCodexBinaryPath(hostRuntime),
  };
}

export function resolveBackendHostTooling(hostRuntime: BackendHostRuntimeContext): ResolvedBackendHostTooling {
  return {
    ripgrepPath: resolveRipgrepPath(hostRuntime),
  };
}

/**
 * F1.1301 — `basePath` with the directory of the host's ripgrep ({@link resolveBackendHostTooling}) APPENDED, or
 * `basePath` unchanged when there is nothing to add (no ripgrep resolved, or its directory is already an entry).
 *
 * The rule Pi's tools already follow (`pi-agent.ts` symbol `piChildStartPath`, F1.727), here for the codex child.
 * Appended, never prepended: a host that already resolves `rg` keeps its own, and a dev run whose resolver fell back
 * to a system `rg` (`/opt/homebrew/bin`, which holds much more) never moves that directory ahead of the user's PATH.
 * codex's own package layout prepends its `codex-path/` instead (`codex-rs/arg0`), a directory holding `rg` alone.
 */
export function appendBundledRipgrepDir(basePath: string | undefined, ripgrepPath: string | undefined): string | undefined {
  const ripgrepDir = ripgrepPath ? dirname(ripgrepPath) : undefined;
  if (!ripgrepDir || (basePath ?? '').split(delimiter).includes(ripgrepDir)) return basePath;
  return basePath ? `${basePath}${delimiter}${ripgrepDir}` : ripgrepDir;
}

/** F1.1301 — the `PATH` entry a child env needs for {@link appendBundledRipgrepDir}, or `{}` when nothing changes. */
export function bundledRipgrepPathEnv(basePath: string | undefined, ripgrepPath: string | undefined): { PATH?: string } {
  const path = appendBundledRipgrepDir(basePath, ripgrepPath);
  return path === undefined || path === basePath ? {} : { PATH: path };
}

/**
 * Configure SDK globals from host runtime context.
 *
 * Since SDK 0.2.113 the SDK spawns a native binary; the only override we
 * need is `pathToClaudeCodeExecutable`. The Bun executable / `--preload`
 * interceptor mechanism that used to live here no longer applies — the
 * binary doesn't accept Bun-specific flags.
 *
 * When `strict` is true (default), throws if the SDK binary can't be found.
 * When `strict` is false, missing paths are silently skipped (the SDK will
 * try its own auto-discovery via optional-dep node_modules resolution).
 */
export function applyAnthropicRuntimeBootstrap(
  hostRuntime: BackendHostRuntimeContext,
  paths: ResolvedBackendRuntimePaths,
  options?: { strict?: boolean },
): void {
  const strict = options?.strict ?? true;

  if (paths.claudeCliPath) {
    setPathToClaudeCodeExecutable(paths.claudeCliPath);
  } else if (strict) {
    throw new Error('Claude support is not included in this build.');
  }
}

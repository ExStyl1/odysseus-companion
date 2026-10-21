import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

export type ScriptRuntimeLanguage = 'python3' | 'node' | 'bun';

export interface ResolvedScriptRuntime {
  command: string;
  argsPrefix: string[];
  source: 'env' | 'bundled' | 'path';
}

export interface ResolveScriptRuntimeContext {
  /**
   * Whether host app is packaged. When omitted, falls back to the
   * `NESSY_IS_PACKAGED` env var, read through `isPackagedEnvValue`.
   * In packaged mode, PATH fallback is blocked by default.
   *
   * Every production caller omits this — `script-sandbox.ts` and
   * `transform-data.ts` both call `resolveScriptRuntime(args.language)` with no
   * context at all — so the env fallback IS the production path, not a
   * convenience. Supplying it in a test therefore exercises a branch no shipped
   * build takes; at least one test per guard must leave it out.
   */
  isPackaged?: boolean;

  /**
   * Optional explicit app root path (usually Electron app.getAppPath()).
   */
  appRootPath?: string;

  /**
   * Optional explicit resources base used by Electron startup.
   * Typically:
   * - packaged: <process.resourcesPath>/app
   * - dev: <repo>/apps/electron
   */
  resourcesBasePath?: string;
}

function resolveBinaryOnPath(binary: string): string | null {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [binary], { encoding: 'utf8' });

  if (result.status !== 0) {
    return null;
  }

  const firstMatch = result.stdout
    ?.split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);

  return firstMatch ?? null;
}

function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolvedCandidate = resolve(candidate);
    if (existsSync(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }
  return null;
}

function getPlatformRuntimeDir(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Canonical reading of `NESSY_IS_PACKAGED`.
 *
 * Established 2026-08-28 from the packaging scripts rather than from what this
 * file expected — the previous spelling here was derived from the code and was
 * wrong in production. What a packaged build actually writes:
 *
 * - `scripts/build-server.ts` emits `export NESSY_IS_PACKAGED=true` into the
 *   generated `bin/nessy-server` launcher and `ENV NESSY_IS_PACKAGED=true` into
 *   the generated Dockerfile. Those are the only packaging scripts that set the
 *   variable at all: `apps/electron/scripts/build-dmg.sh`, `build-win.ps1` and
 *   `build-linux.sh` never mention it — the Electron app assigns it to itself at
 *   runtime from `app.isPackaged`, and writes the same `'true'`/`'false'`.
 * - `docs-site/content/server/headless.md` documents it as
 *   "`true` marks a packaged production build".
 *
 * The three other readers already agree on that spelling
 * (`server-core/src/runtime/platform-headless.ts`,
 * `apps/electron/src/main/logger.ts`, `packages/server/src/index.ts`). This one
 * compared against `'1'` alone, so `inferPackagedMode()` was false on every
 * packaged path and all three `validatePackagedEnvRuntime` call sites below were
 * unreachable in exactly the builds they exist for.
 *
 * `'1'`/`'0'` stays accepted: shipped builds predating this fix write that form
 * from the Electron module scope, and their staged subprocess bundles under
 * `apps/electron/resources` (`pi-agent-server`, `session-mcp-server`) inherit it.
 *
 * An unrecognised value reads as NOT packaged, matching every sibling reader
 * (`=== 'true'` and the `'true'`/`'false'`-only branch in `logger.ts`); the
 * variable being absent is the ordinary dev and test case and must stay false.
 */
export function isPackagedEnvValue(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function inferPackagedMode(ctx?: ResolveScriptRuntimeContext): boolean {
  if (typeof ctx?.isPackaged === 'boolean') return ctx.isPackaged;
  return isPackagedEnvValue(process.env.NESSY_IS_PACKAGED);
}

function getProcessResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

function resolveResourcesBase(ctx?: ResolveScriptRuntimeContext): string | null {
  const explicit = ctx?.resourcesBasePath || process.env.NESSY_RESOURCES_BASE;
  if (explicit) return resolve(explicit);

  const resourcesPath = getProcessResourcesPath();
  if (resourcesPath) {
    const packagedCandidate = join(resourcesPath, 'app');
    if (existsSync(packagedCandidate)) return packagedCandidate;
  }

  return null;
}

function resolveAppRoot(ctx?: ResolveScriptRuntimeContext): string | null {
  const explicit = ctx?.appRootPath || process.env.NESSY_APP_ROOT;
  return explicit ? resolve(explicit) : null;
}

function resolveBundledUv(ctx?: ResolveScriptRuntimeContext): string | null {
  const binary = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const platformDir = getPlatformRuntimeDir();
  const resourcesBase = resolveResourcesBase(ctx);
  const appRoot = resolveAppRoot(ctx);

  const resourcesPath = getProcessResourcesPath();

  return firstExistingPath([
    resourcesBase ? join(resourcesBase, 'resources', 'bin', platformDir, binary) : '',
    appRoot ? join(appRoot, 'resources', 'bin', platformDir, binary) : '',
    resourcesPath ? join(resourcesPath, 'app', 'resources', 'bin', platformDir, binary) : '',
  ]);
}

function resolveBundledNode(ctx?: ResolveScriptRuntimeContext): string | null {
  const binary = process.platform === 'win32' ? 'node.exe' : 'node';
  const resourcesBase = resolveResourcesBase(ctx);
  const appRoot = resolveAppRoot(ctx);

  return firstExistingPath([
    resourcesBase ? join(resourcesBase, 'vendor', 'node', binary) : '',
    appRoot ? join(appRoot, 'vendor', 'node', binary) : '',
  ]);
}

function resolveBundledBun(ctx?: ResolveScriptRuntimeContext): string | null {
  const binary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const resourcesBase = resolveResourcesBase(ctx);
  const appRoot = resolveAppRoot(ctx);

  return firstExistingPath([
    resourcesBase ? join(resourcesBase, 'vendor', 'bun', binary) : '',
    appRoot ? join(appRoot, 'vendor', 'bun', binary) : '',
  ]);
}

function validatePackagedEnvRuntime(command: string, label: string): string {
  const hasPathSeparator = command.includes('/') || command.includes('\\');

  if (!isAbsolute(command) && !hasPathSeparator) {
    throw new Error(
      `${label} runtime from env is not an absolute/bundled path (${command}). ` +
      'Packaged builds do not allow PATH-based runtime resolution. Configure an absolute NESSY_* path or ship a bundled runtime.'
    );
  }

  const resolvedCommand = resolve(command);
  if (!existsSync(resolvedCommand)) {
    throw new Error(
      `${label} runtime from env does not exist: ${resolvedCommand}. ` +
      'Configure a valid absolute NESSY_* path or ship a bundled runtime.'
    );
  }

  return resolvedCommand;
}

/**
 * Resolve runtime command and fixed argument prefix for script execution tools.
 *
 * Resolution order:
 * - env override (NESSY_UV / NESSY_NODE / NESSY_BUN)
 * - bundled binary path (when available)
 * - PATH fallback (dev only)
 */
export function resolveScriptRuntime(
  language: ScriptRuntimeLanguage,
  ctx?: ResolveScriptRuntimeContext,
): ResolvedScriptRuntime {
  const isPackaged = inferPackagedMode(ctx);

  if (language === 'python3') {
    if (process.env.NESSY_UV) {
      const cmd = isPackaged
        ? validatePackagedEnvRuntime(process.env.NESSY_UV, 'Python/uv')
        : process.env.NESSY_UV;

      return {
        command: cmd,
        argsPrefix: ['run', '--python', '3.12'],
        source: 'env',
      };
    }

    const bundledUv = resolveBundledUv(ctx);
    if (bundledUv) {
      return {
        command: bundledUv,
        argsPrefix: ['run', '--python', '3.12'],
        source: 'bundled',
      };
    }

    if (!isPackaged) {
      const uvPath = resolveBinaryOnPath('uv');
      if (uvPath) {
        return {
          command: uvPath,
          argsPrefix: ['run', '--python', '3.12'],
          source: 'path',
        };
      }
    }

    throw new Error(
      isPackaged
        ? 'Python runtime unavailable in packaged app: uv was not found in env or bundled resources.'
        : 'Python runtime unavailable: uv was not found. Configure NESSY_UV or install uv on PATH.'
    );
  }

  if (language === 'node') {
    if (process.env.NESSY_NODE) {
      const cmd = isPackaged
        ? validatePackagedEnvRuntime(process.env.NESSY_NODE, 'Node')
        : process.env.NESSY_NODE;
      return { command: cmd, argsPrefix: [], source: 'env' };
    }

    const bundledNode = resolveBundledNode(ctx);
    if (bundledNode) {
      return { command: bundledNode, argsPrefix: [], source: 'bundled' };
    }

    if (!isPackaged) {
      const nodePath = resolveBinaryOnPath('node');
      if (nodePath) {
        return { command: nodePath, argsPrefix: [], source: 'path' };
      }
    }

    throw new Error(
      isPackaged
        ? 'Node runtime unavailable in packaged app: node was not found in env or bundled resources.'
        : 'Node runtime unavailable: configure NESSY_NODE or install node on PATH.'
    );
  }

  if (process.env.NESSY_BUN) {
    const cmd = isPackaged
      ? validatePackagedEnvRuntime(process.env.NESSY_BUN, 'Bun')
      : process.env.NESSY_BUN;
    return { command: cmd, argsPrefix: [], source: 'env' };
  }

  const bundledBun = resolveBundledBun(ctx);
  if (bundledBun) {
    return { command: bundledBun, argsPrefix: [], source: 'bundled' };
  }

  if (!isPackaged) {
    const bunPath = resolveBinaryOnPath('bun');
    if (bunPath) {
      return { command: bunPath, argsPrefix: [], source: 'path' };
    }
  }

  throw new Error(
    isPackaged
      ? 'Bun runtime unavailable in packaged app: bun was not found in env or bundled resources.'
      : 'Bun runtime unavailable: configure NESSY_BUN or install bun on PATH.'
  );
}

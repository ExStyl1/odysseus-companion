import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import type { BackendHostRuntimeContext } from '../types.ts';

export interface ResolvedBackendRuntimePaths {
  nessyCliPath?: string;
  nodeRuntimePath?: string;
  bundledRuntimePath?: string;
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function nessySourceCliCandidates(root: string): string[] {
  return [
    join(root, 'scripts', 'dev.js'),
    join(root, 'dist', 'cli.js'),
    join(root, 'cli.js'),
    join(root, 'packages', 'cli', 'dist', 'index.js'),
  ];
}

function isNessySourceRoot(root: string): boolean {
  return (
    existsSync(join(root, 'packages', 'cli', 'package.json')) &&
    existsSync(join(root, 'packages', 'desktop', 'package.json'))
  );
}

function resolveNessySourceCliFromAncestors(
  base: string,
  maxLevels = 10,
): { path?: string; foundSourceRoot: boolean } {
  let dir = resolve(base);
  for (let i = 0; i <= maxLevels; i++) {
    if (isNessySourceRoot(dir)) {
      return {
        path: firstExistingPath(nessySourceCliCandidates(dir)),
        foundSourceRoot: true,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { foundSourceRoot: false };
}

function resolveNessyCliOverride(): string | undefined {
  const override =
    process.env.NESSY_CLI ||
    process.env.NESSY_CLI_PATH ||
    process.env.NESSY_CLI_ROOT;
  if (!override || !existsSync(override)) return undefined;
  if (isDirectory(override)) {
    return firstExistingPath(nessySourceCliCandidates(override));
  }
  return override;
}

function resolveUpwards(
  base: string,
  relativePath: string,
  maxLevels = 4,
): string | undefined {
  let dir = resolve(base);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// [nessy-fork] desktop-bundled-runtime-packaging
function resolveBundledRuntimePath(
  hostRuntime: BackendHostRuntimeContext,
): string | undefined {
  const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const bunBasePath =
    process.platform === 'win32'
      ? hostRuntime.resourcesPath || hostRuntime.appRootPath
      : hostRuntime.appRootPath;
  const bunDir = join(bunBasePath, 'vendor', 'bun');
  const bunPath = join(
    bunDir,
    `${process.platform}-${process.arch}`,
    bunBinary,
  );
  if (existsSync(bunPath)) return bunPath;

  const legacyBunPath = join(bunDir, bunBinary);
  if (existsSync(legacyBunPath)) return legacyBunPath;

  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemBun = execFileSync(whichCmd, ['bun'], {
        encoding: 'utf-8',
      }).trim();
      if (systemBun && existsSync(systemBun)) return systemBun;
    } catch {
      // System runtime not found.
    }
  }
  return undefined;
}

function resolveNodeRuntimePath(
  hostRuntime: BackendHostRuntimeContext,
): string | undefined {
  if (hostRuntime.nodeRuntimePath && existsSync(hostRuntime.nodeRuntimePath)) {
    return hostRuntime.nodeRuntimePath;
  }

  const nodeBinary = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodeBasePath =
    process.platform === 'win32'
      ? hostRuntime.resourcesPath || hostRuntime.appRootPath
      : hostRuntime.appRootPath;
  const nodePath =
    process.platform === 'win32'
      ? join(nodeBasePath, 'vendor', 'node', nodeBinary)
      : join(nodeBasePath, 'vendor', 'node', 'bin', nodeBinary);
  if (existsSync(nodePath)) return nodePath;

  if (hostRuntime.isPackaged && process.versions.electron) {
    return process.execPath;
  }

  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemNode = execFileSync(whichCmd, ['node'], {
        encoding: 'utf-8',
      }).trim();
      if (systemNode && existsSync(systemNode)) return systemNode;
    } catch {
      // System Node runtime not found.
    }
  }

  return undefined;
}

function resolveNessyCliPath(
  hostRuntime: BackendHostRuntimeContext,
): string | undefined {
  const envOverride = resolveNessyCliOverride();
  if (envOverride) return envOverride;

  const packagedCliRelative = join('vendor', 'nessy-cli', 'dist', 'cli.js');
  const packagedRootCliRelative = join('vendor', 'nessy-cli', 'cli.js');
  const packagedIndexRelative = join(
    'vendor',
    'nessy-cli',
    'packages',
    'cli',
    'dist',
    'index.js',
  );
  const packagedCandidates = [
    join(hostRuntime.appRootPath, packagedCliRelative),
    join(hostRuntime.appRootPath, packagedRootCliRelative),
    join(hostRuntime.appRootPath, packagedIndexRelative),
    join(hostRuntime.appRootPath, 'apps', 'electron', packagedCliRelative),
    join(hostRuntime.appRootPath, 'apps', 'electron', packagedRootCliRelative),
    join(hostRuntime.appRootPath, 'apps', 'electron', packagedIndexRelative),
    ...(hostRuntime.resourcesPath
      ? [
          join(hostRuntime.resourcesPath, 'app', packagedCliRelative),
          join(hostRuntime.resourcesPath, 'app', packagedRootCliRelative),
          join(hostRuntime.resourcesPath, 'app', packagedIndexRelative),
        ]
      : []),
  ];

  if (hostRuntime.isPackaged) {
    return firstExistingPath(packagedCandidates);
  }

  const packageCliRelative = join(
    'node_modules',
    '@nessy-cli',
    'nessy-cli',
    'dist',
    'cli.js',
  );
  const packageRootCliRelative = join(
    'node_modules',
    '@nessy-cli',
    'nessy-cli',
    'cli.js',
  );
  const packageIndexRelative = join(
    'node_modules',
    '@nessy-cli',
    'nessy-cli',
    'packages',
    'cli',
    'dist',
    'index.js',
  );
  const appRootCheckout = resolveNessySourceCliFromAncestors(
    hostRuntime.appRootPath,
  );
  const cwdCheckout = resolveNessySourceCliFromAncestors(process.cwd());
  const currentCheckoutCli = appRootCheckout.path ?? cwdCheckout.path;
  if (currentCheckoutCli) return currentCheckoutCli;

  if (appRootCheckout.foundSourceRoot || cwdCheckout.foundSourceRoot) {
    return undefined;
  }

  const fromHostRoot = firstExistingPath([
    ...packagedCandidates,
    join(hostRuntime.appRootPath, packageCliRelative),
    join(hostRuntime.appRootPath, packageRootCliRelative),
    join(hostRuntime.appRootPath, packageIndexRelative),
    join(hostRuntime.appRootPath, '..', '..', packageCliRelative),
    join(hostRuntime.appRootPath, '..', '..', packageRootCliRelative),
    join(hostRuntime.appRootPath, '..', '..', packageIndexRelative),
  ]);
  if (fromHostRoot) return fromHostRoot;

  const walked =
    resolveUpwards(hostRuntime.appRootPath, packageCliRelative, 10) ??
    resolveUpwards(hostRuntime.appRootPath, packageRootCliRelative, 10) ??
    resolveUpwards(hostRuntime.appRootPath, packageIndexRelative, 10);
  if (walked) return walked;

  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemNessy = execFileSync(whichCmd, ['nessy'], {
        encoding: 'utf-8',
      }).trim();
      if (systemNessy && existsSync(systemNessy)) return systemNessy;
    } catch {
      // System Nessy CLI not found.
    }
  }

  return undefined;
}

function resolveRipgrepPath(
  hostRuntime: BackendHostRuntimeContext,
): string | undefined {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const relativePath = join(
    'vendor',
    'nessy-cli',
    'vendor',
    'ripgrep',
    `${process.arch}-${process.platform}`,
    binary,
  );
  const bundled = firstExistingPath([
    join(hostRuntime.appRootPath, relativePath),
    join(hostRuntime.appRootPath, 'apps', 'electron', relativePath),
    join(
      hostRuntime.appRootPath,
      'packages',
      'desktop',
      'apps',
      'electron',
      relativePath,
    ),
  ]);
  if (bundled) return bundled;

  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemRg = execFileSync(whichCmd, ['rg'], {
        encoding: 'utf-8',
      }).trim();
      if (systemRg && existsSync(systemRg)) return systemRg;
    } catch {
      // System ripgrep not found.
    }
  }

  return undefined;
}

export function resolveBackendRuntimePaths(
  hostRuntime: BackendHostRuntimeContext,
): ResolvedBackendRuntimePaths {
  const bundledRuntimePath = resolveBundledRuntimePath(hostRuntime);

  return {
    nessyCliPath: resolveNessyCliPath(hostRuntime),
    nodeRuntimePath:
      resolveNodeRuntimePath(hostRuntime) ||
      bundledRuntimePath ||
      process.execPath,
    bundledRuntimePath,
  };
}

export function resolveBackendHostTooling(
  hostRuntime: BackendHostRuntimeContext,
): ResolvedBackendHostTooling {
  return {
    ripgrepPath: resolveRipgrepPath(hostRuntime),
  };
}

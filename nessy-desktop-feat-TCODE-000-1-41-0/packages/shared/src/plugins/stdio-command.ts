import { constants, accessSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { satisfies, validRange } from 'semver';

export type PluginStdioHostRuntime = 'node' | 'dp' | 'npx' | 'bunx' | 'uvx' | 'python';

const HOST_RUNTIMES = new Map<string, PluginStdioHostRuntime>([
  ['node', 'node'],
  ['node.exe', 'node'],
  ['dp', 'dp'],
  ['dp.exe', 'dp'],
  ['npx', 'npx'],
  ['npx.cmd', 'npx'],
  ['bunx', 'bunx'],
  ['bunx.exe', 'bunx'],
  ['bunx.cmd', 'bunx'],
  ['uvx', 'uvx'],
  ['uvx.exe', 'uvx'],
  ['python', 'python'],
  ['python.exe', 'python'],
  ['python3', 'python'],
  ['python3.exe', 'python'],
]);

const PLUGIN_ROOT = '${NESSY_PLUGIN_ROOT}';
const BARE_PLUGIN_ROOT = '$NESSY_PLUGIN_ROOT';

export type PluginStdioCommandQualification =
  | { ok: true; kind: 'host'; runtime: PluginStdioHostRuntime; command: string }
  | { ok: true; kind: 'bundle'; command: string; executablePath: string }
  | { ok: false; reason: 'unavailable' | 'outside-bundle' };

/** Qualify without PATH lookup; bundle commands become portable root-token paths. */
export function qualifyPluginStdioCommand(
  command: string,
  bundleRoot: string,
): PluginStdioCommandQualification {
  const hostRuntime = HOST_RUNTIMES.get(command);
  if (hostRuntime) return { ok: true, kind: 'host', runtime: hostRuntime, command };

  let relativeCommand = command;
  let usesApprovedPluginRoot = false;
  if (relativeCommand.startsWith(`${PLUGIN_ROOT}/`)) {
    usesApprovedPluginRoot = true;
    relativeCommand = relativeCommand.slice(PLUGIN_ROOT.length + 1);
  } else if (relativeCommand.startsWith(`${BARE_PLUGIN_ROOT}/`)) {
    usesApprovedPluginRoot = true;
    relativeCommand = relativeCommand.slice(BARE_PLUGIN_ROOT.length + 1);
  } else {
    while (relativeCommand.startsWith('./')) relativeCommand = relativeCommand.slice(2);
  }
  if (
    !relativeCommand
    || isAbsolute(command)
    || /^[A-Za-z]:[\\/]/.test(command)
    || command.includes('\0')
    || command.includes('\\')
    || (!usesApprovedPluginRoot && command.includes('${'))
    || (!usesApprovedPluginRoot && /\$[A-Za-z_]/.test(command))
  ) {
    return { ok: false, reason: isAbsolute(command) ? 'outside-bundle' : 'unavailable' };
  }
  const parts = relativeCommand.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    return { ok: false, reason: parts.includes('..') ? 'outside-bundle' : 'unavailable' };
  }

  try {
    const canonicalRoot = realpathSync(bundleRoot);
    const executablePath = realpathSync(join(canonicalRoot, ...parts));
    const containedPath = relative(canonicalRoot, executablePath);
    if (!containedPath || containedPath.startsWith('..') || isAbsolute(containedPath)) {
      return { ok: false, reason: 'outside-bundle' };
    }
    if (!statSync(executablePath).isFile()) return { ok: false, reason: 'unavailable' };
    accessSync(executablePath, constants.X_OK);
    return {
      ok: true,
      kind: 'bundle',
      command: `${PLUGIN_ROOT}/${containedPath.split(sep).join('/')}`,
      executablePath,
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export function hasMaterializablePluginPackageRunner(rootDirectory: string, args: string[]): boolean {
  const parsed = parsePluginPackageRunnerArgs(args);
  if (!parsed.ok) return false;
  const { packageName } = parsed;
  if (hasVendoredExecutable(rootDirectory, parsed)) return true;
  if (!['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json']
    .some(lockfile => statIsFile(join(rootDirectory, lockfile)))) return false;
  const declaredSpec = declaredPackageSpec(rootDirectory, packageName);
  return parsed.versionExplicit ? declaredSpec === parsed.versionSpec : declaredSpec !== undefined;
}

export type PluginPackageRunnerArgs =
  | {
      ok: true;
      packageName: string;
      packageSpec: string;
      versionSpec: string;
      versionExplicit: boolean;
      packageArgs: string[];
    }
  | { ok: false; reason: 'unsupported-arguments' | 'invalid-package-spec' };

export function parsePluginPackageRunnerArgs(args: string[]): PluginPackageRunnerArgs {
  const packageIndex = args.findIndex(arg => arg !== '-y' && arg !== '--yes');
  if (packageIndex < 0 || args.slice(0, packageIndex).some(arg => arg !== '-y' && arg !== '--yes')) {
    return { ok: false, reason: 'unsupported-arguments' };
  }
  const packageSpec = args[packageIndex]!;
  if (packageSpec.startsWith('-')) return { ok: false, reason: 'unsupported-arguments' };
  const versionSeparator = packageSpec.startsWith('@')
    ? packageSpec.indexOf('@', packageSpec.indexOf('/') + 1)
    : packageSpec.indexOf('@');
  const packageName = versionSeparator > 0 ? packageSpec.slice(0, versionSeparator) : packageSpec;
  const versionSpec = versionSeparator > 0 ? packageSpec.slice(versionSeparator + 1) : undefined;
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(packageName)
    || (versionSpec !== undefined && !isRegistryVersionSpec(versionSpec))) {
    return { ok: false, reason: 'invalid-package-spec' };
  }
  return {
    ok: true,
    packageName,
    packageSpec,
    versionSpec: versionSpec ?? 'latest',
    versionExplicit: versionSpec !== undefined,
    packageArgs: args.slice(packageIndex + 1),
  };
}

export function pluginNpxRuntimeRoot(bundleRoot: string): string {
  return join(bundleRoot, '.nessy-runtime', 'npx');
}

export function hasMaterializedPluginPackageRunner(rootDirectory: string, args: string[]): boolean {
  const parsed = parsePluginPackageRunnerArgs(args);
  return parsed.ok && hasVendoredExecutable(rootDirectory, parsed);
}

function isRegistryVersionSpec(spec: string): boolean {
  if (!spec || /^(?:file|link|workspace|git|https?|github|npm):/i.test(spec)) return false;
  return validRange(spec) !== null || /^[a-z0-9][a-z0-9._-]*$/i.test(spec);
}

function hasVendoredExecutable(
  rootDirectory: string,
  parsed: Extract<PluginPackageRunnerArgs, { ok: true }>,
): boolean {
  const { packageName, versionSpec } = parsed;
  const packageRoot = join(rootDirectory, 'node_modules', ...packageName.split('/'));
  try {
    const canonicalBundleRoot = realpathSync(rootDirectory);
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
    if (manifest.name !== packageName) return false;
    if (parsed.versionExplicit) {
      const range = validRange(versionSpec);
      if (range !== null) {
        if (typeof manifest.version !== 'string' || !satisfies(manifest.version, range)) return false;
      } else if (declaredPackageSpec(rootDirectory, packageName) !== versionSpec) {
        return false;
      }
    }
    const defaultBin = packageName.split('/').pop()!;
    const bin = typeof manifest.bin === 'string'
      ? manifest.bin
      : manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)
        ? ((manifest.bin as Record<string, unknown>)[defaultBin]
          ?? (Object.keys(manifest.bin).length === 1 ? Object.values(manifest.bin)[0] : undefined))
        : undefined;
    if (typeof bin !== 'string' || isAbsolute(bin) || bin.split(/[\\/]/).includes('..')) return false;
    const canonicalPackageRoot = realpathSync(packageRoot);
    const packagePath = relative(canonicalBundleRoot, canonicalPackageRoot);
    if (!packagePath || packagePath.startsWith('..') || isAbsolute(packagePath)) return false;
    const executable = realpathSync(join(packageRoot, bin));
    const containedPath = relative(canonicalPackageRoot, executable);
    return !!containedPath && !containedPath.startsWith('..') && !isAbsolute(containedPath)
      && statSync(executable).isFile();
  } catch {
    return false;
  }
}

function declaredPackageSpec(rootDirectory: string, packageName: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(rootDirectory, 'package.json'), 'utf-8')) as Record<string, unknown>;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = manifest[field];
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
      const spec = (dependencies as Record<string, unknown>)[packageName];
      if (typeof spec === 'string') return spec;
    }
  } catch {
    // Missing package metadata cannot bind a registry tag.
  }
  return undefined;
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

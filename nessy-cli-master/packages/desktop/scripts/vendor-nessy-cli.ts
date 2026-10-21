import { spawn } from 'bun';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const desktopRoot = join(import.meta.dir, '..');
const defaultRepoRoot = join(desktopRoot, '..', '..');
const electronDir = join(desktopRoot, 'apps', 'electron');
const vendorDir = join(electronDir, 'vendor', 'nessy-cli');
const nessyCodePackageName = '@nestor/nessy-cli';
const nessyCodeMetadataUrl = `https://artifactory.tcsbank.ru/artifactory/api/npm/npm-nestor/${encodeURIComponent(nessyCodePackageName)}`;

interface DesktopPackageJson {
  nessyCodeRuntime?: {
    version?: string;
  };
}

interface NpmPackageMetadata {
  'dist-tags'?: Record<string, string>;
  versions?: Record<
    string,
    {
      dist?: {
        tarball?: string;
      };
    }
  >;
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = spawn({
    cmd,
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed with exit code ${exitCode}`);
  }
}

function isNessySourceRoot(root: string): boolean {
  return (
    existsSync(join(root, 'packages', 'cli', 'package.json')) &&
    existsSync(join(root, 'package.json'))
  );
}

function resolveLocalSourceRootOverride(): string | undefined {
  const root = process.env.NESSY_CLI_ROOT?.trim();
  if (root) return resolve(root);

  const path = process.env.NESSY_CLI_PATH?.trim();
  if (path) return resolve(path);

  return undefined;
}

function readDefaultNessyCLIVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(desktopRoot, 'package.json'), 'utf-8'),
    ) as DesktopPackageJson;
    const version = pkg.nessyCodeRuntime?.version?.trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}

function verifyVendoredCli(): void {
  const hasRootCli = existsSync(join(vendorDir, 'cli.js'));
  const hasDistCli = existsSync(join(vendorDir, 'dist', 'cli.js'));
  if (!hasRootCli && !hasDistCli) {
    throw new Error(
      `Nessy CLI not found in ${vendorDir}. Expected cli.js or dist/cli.js.`,
    );
  }
}

async function vendorLocalCheckout(repoRoot: string): Promise<void> {
  if (!isNessySourceRoot(repoRoot)) {
    throw new Error(
      `Nessy CLI source checkout not found at ${repoRoot}. Set NESSY_CLI_VERSION, NESSY_CLI_TARBALL, or NESSY_CLI_ROOT.`,
    );
  }

  console.log(`Building Nessy CLI from ${repoRoot}...`);

  const npm = npmCommand();
  await run(
    [npm, 'run', 'build', '--', '--cli-only', '--web-shell'],
    repoRoot,
  );
  await run([npm, 'run', 'bundle'], repoRoot);
  await run([npm, 'run', 'prepare:package'], repoRoot);

  const localDistDir = join(repoRoot, 'dist');
  if (!existsSync(join(localDistDir, 'cli.js'))) {
    throw new Error(
      `Local Nessy CLI bundle not found at ${join(localDistDir, 'cli.js')}.`,
    );
  }

  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });
  cpSync(localDistDir, vendorDir, { recursive: true, force: true });
  verifyVendoredCli();
  console.log(`Vendored local Nessy CLI into ${vendorDir}`);
}

async function readNpmPackageMetadata(): Promise<NpmPackageMetadata> {
  const response = await fetch(nessyCodeMetadataUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to read ${nessyCodePackageName} metadata from npm: HTTP ${response.status}`,
    );
  }
  return (await response.json()) as NpmPackageMetadata;
}

async function resolveNpmVersionOrTag(
  versionOrTag: string,
): Promise<{ tarballUrl: string; version: string }> {
  const requested = versionOrTag.trim();
  if (!requested) {
    throw new Error('Nessy CLI npm version or dist-tag is required.');
  }

  const metadata = await readNpmPackageMetadata();
  const version = metadata.versions?.[requested]
    ? requested
    : metadata['dist-tags']?.[requested];
  if (!version) {
    throw new Error(
      `Could not resolve ${nessyCodePackageName}@${requested} from npm.`,
    );
  }

  const tarballUrl = metadata.versions?.[version]?.dist?.tarball;
  if (!tarballUrl) {
    throw new Error(
      `Could not find npm tarball for ${nessyCodePackageName}@${version}.`,
    );
  }

  return { tarballUrl, version };
}

async function vendorNpmVersion(versionOrTag: string): Promise<void> {
  const { tarballUrl, version } = await resolveNpmVersionOrTag(versionOrTag);
  const sourceLabel =
    versionOrTag === version ? version : `${versionOrTag} (${version})`;
  console.log(`Downloading Nessy CLI ${sourceLabel} from npm...`);

  const tempDir = mkdtempSync(join(tmpdir(), 'nessy-cli-vendor-'));
  const tarballPath = join(tempDir, `nessy-cli-${version}.tgz`);

  try {
    const response = await fetch(tarballUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download ${tarballUrl}: HTTP ${response.status}`,
      );
    }
    await Bun.write(tarballPath, await response.arrayBuffer());

    rmSync(vendorDir, { recursive: true, force: true });
    mkdirSync(vendorDir, { recursive: true });

    const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
    await run(
      [tar, '-xzf', tarballPath, '-C', vendorDir, '--strip-components=1'],
      desktopRoot,
    );

    verifyVendoredCli();
    console.log(`Vendored ${nessyCodePackageName}@${version} into ${vendorDir}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function vendorTarball(tarballPath: string): Promise<void> {
  const source = resolve(tarballPath);
  if (!existsSync(source)) {
    throw new Error(`Nessy CLI tarball not found: ${source}`);
  }

  console.log(`Vendoring Nessy CLI from tarball ${source}...`);

  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });

  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  await run(
    [tar, '-xzf', source, '-C', vendorDir, '--strip-components=1'],
    desktopRoot,
  );

  verifyVendoredCli();
  console.log(`Vendored Nessy CLI tarball into ${vendorDir}`);
}

async function main(): Promise<void> {
  const tarballPath = process.env.NESSY_CLI_TARBALL?.trim();
  if (tarballPath) {
    await vendorTarball(tarballPath);
    return;
  }

  const npmVersion = process.env.NESSY_CLI_VERSION?.trim();
  if (npmVersion) {
    await vendorNpmVersion(npmVersion);
    return;
  }

  const sourceRootOverride = resolveLocalSourceRootOverride();
  if (sourceRootOverride) {
    await vendorLocalCheckout(sourceRootOverride);
    return;
  }

  if (isNessySourceRoot(defaultRepoRoot)) {
    await vendorLocalCheckout(defaultRepoRoot);
    return;
  }

  const defaultVersion = readDefaultNessyCLIVersion();
  if (defaultVersion) {
    await vendorNpmVersion(defaultVersion);
    return;
  }

  await vendorLocalCheckout(defaultRepoRoot);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

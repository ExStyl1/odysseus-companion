import { spawn } from 'bun';
import { dirname, join, delimiter } from 'path';
import {
  getBundledBunPath,
  getBundledUvPath,
  verifyBundledBun,
  verifyBundledUv,
  type Arch,
  type BuildConfig,
  type Platform,
} from './build/common';

const rootDir = join(import.meta.dir, '..');
const electronDir = join(rootDir, 'apps', 'electron');

if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
  throw new Error(`Unsupported runtime platform: ${process.platform}`);
}
if (!['arm64', 'x64'].includes(process.arch)) {
  throw new Error(`Unsupported runtime architecture: ${process.arch}`);
}

const platform = process.platform as Platform;
const arch = process.arch as Arch;
const config: BuildConfig = {
  platform,
  arch,
  upload: false,
  uploadLatest: false,
  uploadScript: false,
  rootDir,
  electronDir,
};

await verifyBundledBun(config);
await verifyBundledUv(config);

const bunPath = getBundledBunPath(electronDir, platform, arch);
const env = {
  ...(process.env as Record<string, string>),
  CRAFT_BUN: bunPath,
  CRAFT_UV: getBundledUvPath(electronDir, platform, arch),
  PATH: `${dirname(bunPath)}${delimiter}${process.env.PATH ?? ''}`,
};

const build = spawn({
  cmd: [bunPath, 'run', 'electron:build'],
  cwd: rootDir,
  env,
  stdout: 'inherit',
  stderr: 'inherit',
});
if ((await build.exited) !== 0) process.exit(1);

const electronBinary = join(
  rootDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);
const electron = spawn({
  cmd: [electronBinary, 'apps/electron'],
  cwd: rootDir,
  env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await electron.exited);

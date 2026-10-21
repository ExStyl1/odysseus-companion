import { join } from 'path';

// [nessy-fork] desktop-bundled-runtime-packaging
import {
  type Arch,
  type BuildConfig,
  type Platform,
  verifyBundledBun,
  verifyBundledUv,
} from './build/common';

const requestedPlatform = process.argv[2] ?? process.platform;
if (!['darwin', 'linux', 'win32'].includes(requestedPlatform)) {
  throw new Error(`Unsupported runtime platform: ${requestedPlatform}`);
}
const platform = requestedPlatform as Platform;
const requestedArch = process.argv[3];
if (requestedArch && !['arm64', 'x64'].includes(requestedArch)) {
  throw new Error(`Unsupported runtime architecture: ${requestedArch}`);
}
const arches: Arch[] = requestedArch
  ? [requestedArch as Arch]
  : platform === 'darwin'
    ? ['arm64', 'x64']
    : ['x64'];
const rootDir = process.cwd();
const electronDir = join(rootDir, 'apps', 'electron');

for (const arch of arches) {
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
}

import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { join } from 'node:path';
import {
  buildMcpServers,
  copyPiAgentServer,
  copySessionServer,
  verifyMcpServersExist,
  type Arch,
  type BuildConfig,
  type Platform,
} from './build/common.ts';

const platforms = new Set<Platform>(['darwin', 'win32', 'linux']);
const arches = new Set<Arch>(['x64', 'arm64']);

function readPlatform(): Platform {
  const value = process.env.NESSY_TARGET_PLATFORM || hostPlatform();
  if (platforms.has(value as Platform)) return value as Platform;
  throw new Error(`Unsupported NESSY_TARGET_PLATFORM: ${value}`);
}

function readArch(): Arch {
  const value = process.env.NESSY_TARGET_ARCH || hostArch();
  if (arches.has(value as Arch)) return value as Arch;
  throw new Error(`Unsupported NESSY_TARGET_ARCH: ${value}`);
}

const rootDir = join(import.meta.dir, '..');
const electronDir = join(rootDir, 'apps', 'electron');
const config: BuildConfig = {
  platform: readPlatform(),
  arch: readArch(),
  upload: false,
  uploadLatest: false,
  uploadScript: false,
  rootDir,
  electronDir,
};

buildMcpServers(config);
copySessionServer(config);
copyPiAgentServer(config);
verifyMcpServersExist(config);

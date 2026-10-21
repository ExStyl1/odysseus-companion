/**
 * DP CLI configuration constants and platform utilities.
 * Ported from assistant's auth/config.ts and utils/dpUtils.ts.
 */

import * as os from 'node:os';
import * as path from 'node:path';
// [nessy-fork] mcp-managed-dp-placeholder
import { Storage } from '../config/storage.js';

export enum DpPlatform {
  Windows = 'win32',
  Linux = 'linux',
  Darwin = 'darwin',
}

// [nessy-fork] dp-auth
export const DP_CONFIG = {
  version: '13.65.1',
  workDirName: 'dp_latest',
  workDirEnv: 'DP_WORKDIR',
  tokenTTL: 5 * 60 * 1000, // 5 min
  downloadTimeout: 5 * 60 * 1000, // 5 min (binary download on slow networks)
  printTokenArgs: ['auth', 'print-token'],
  // Any dp subcommand (unlike the --version/--help flags) runs a startup hook
  // that opens a network connection and gives up on its own after ~5s when the
  // host is unreachable. A 5s budget here raced that hook and aborted dp right
  // before it printed the token.
  printTokenTimeout: 30_000, // 30s
  versionArgs: ['version'],
  versionFlagArgs: ['--version'],
  // [nessy-fork] dp-binary-lifecycle
  versionCheckTimeout: 15_000, // 15s
  loginArgs: ['auth', 'login'],
  updateArgs: ['update'],
  updateTimeout: 300_000, // 5 min (dp update downloads a new binary)
  /** Mode for the managed binary: owner-only rwx. */
  binaryMode: 0o700,
  downloadUrlPrefix:
    'https://code-completion-nestor.tcsbank.ru/api/v2/download/dp',
  md5Checksums: {
    [DpPlatform.Windows]: '5b20b8faa94beedc4e5337f1102bd380',
    [DpPlatform.Linux]: 'df0b5deb8b96825a01307327861107b2',
    [DpPlatform.Darwin]: '03c50f89fca5d95accc2d592425ddfd3',
  } as Record<string, string>,
  tokenExchangeTimeout: 30_000, // 30s timeout for token exchange
  credentialsFileName: 'dp_auth_creds.json',
} as const;

export function getAvailablePlatform(): DpPlatform {
  switch (os.platform()) {
    case 'win32':
      return DpPlatform.Windows;
    case 'darwin':
      return DpPlatform.Darwin;
    case 'linux':
      return DpPlatform.Linux;
    default:
      throw new Error(`Unsupported operating system: ${os.platform()}`);
  }
}

export function dpBaseName(platform: DpPlatform): string {
  return platform === DpPlatform.Windows ? 'dp.exe' : 'dp';
}

export function buildDpDownloadUrl(
  prefix: string,
  version: string,
  platform: DpPlatform,
): string {
  const platformDir =
    platform === DpPlatform.Windows
      ? 'windows'
      : platform === DpPlatform.Linux
        ? 'linux'
        : 'darwin/universal';
  return `${prefix}/${version}/${platformDir}/${dpBaseName(platform)}`;
}

/** <NESSY_HOME>/dp_latest/ */
export function getDpFolderPath(): string {
  // [nessy-fork] mcp-managed-dp-placeholder
  return path.join(Storage.getGlobalNessyDir(), DP_CONFIG.workDirName);
}

/** <NESSY_HOME>/dp_latest/dp (or dp.exe on Windows) */
export function getDpFilePath(): string {
  return path.join(getDpFolderPath(), dpBaseName(getAvailablePlatform()));
}

/** <NESSY_HOME>/dp_auth_creds.json */
export function getDpCredentialsPath(): string {
  // [nessy-fork] mcp-managed-dp-placeholder
  return path.join(Storage.getGlobalNessyDir(), DP_CONFIG.credentialsFileName);
}

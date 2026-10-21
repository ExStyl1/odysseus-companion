/**
 * DP CLI binary download and management.
 * Ported from assistant's auth/dpDownloader.ts and utils/dpUtils.ts.
 */

// [nessy-fork] dp-binary-lifecycle

import { execFile as execFileCallback } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as stream from 'node:stream';
import type * as streamWeb from 'node:stream/web';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  DP_CONFIG,
  DpPlatform,
  buildDpDownloadUrl,
  getAvailablePlatform,
  getDpFilePath,
  getDpFolderPath,
} from './dp-config.js';
import { DpAuthError, DpAuthServiceError } from './dp-errors.js';

const execFileAsync = promisify(execFileCallback);
const logger = createDebugLogger('DP');

const VERSION_OUTPUT_RE = /Spirit CLI Version: (\d+\.\d+\.\d+)/;

let ensureRequest: Promise<void> | undefined;

/**
 * Ensure a working DP binary is installed.
 *
 * 1. Install the pinned binary when missing, broken, or pending macOS migration.
 *
 * A binary that fails to run is treated as corrupted and downloaded again —
 * users have hit truncated binaries in the field. Checking for a newer
 * version is decoupled from here: it runs in the background via
 * `checkForDpUpdateAvailable()` so a slow `dp update` never blocks startup.
 * Concurrent callers share a single inflight run so parallel entry points
 * cannot download over each other.
 */
export async function ensureDpPresence(): Promise<void> {
  if (ensureRequest) {
    return ensureRequest;
  }
  ensureRequest = ensureDpPresenceImpl();
  try {
    return await ensureRequest;
  } finally {
    ensureRequest = undefined;
  }
}

async function ensureDpPresenceImpl(): Promise<void> {
  const folderPath = getDpFolderPath();
  const filePath = getDpFilePath();
  const universalMarkerPath = path.join(folderPath, '.universal-v1');
  const needsUniversalMigration =
    getAvailablePlatform() === DpPlatform.Darwin &&
    !fs.existsSync(universalMarkerPath);

  if (!fs.existsSync(folderPath)) {
    logger.info('Creating DP folder:', folderPath);
    fs.mkdirSync(folderPath, { recursive: true, mode: 0o700 });
  }

  if (!fs.existsSync(filePath)) {
    logger.info('DP binary not found, downloading...');
    await installFreshBinary(filePath);
  } else if (!(await isDpRunnable(filePath))) {
    logger.warn('DP binary cannot run — reinstalling');
    await installFreshBinary(filePath);
  } else {
    await ensureExecutablePermissions(filePath);
    if (needsUniversalMigration) {
      try {
        logger.info('Migrating DP to universal...');
        await installFreshBinary(filePath);
      } catch (error) {
        logger.warn(
          'DP universal migration failed — keeping installed binary:',
          error,
        );
        return;
      }
    }
  }

  if (needsUniversalMigration) {
    await fsPromises.writeFile(universalMarkerPath, '', { mode: 0o600 });
  }
}

export function removeDp(): void {
  try {
    const filePath = getDpFilePath();
    fs.rmSync(filePath, { force: true });
    logger.info('Removed DP binary');
  } catch (error) {
    logger.error('Unexpected error removing DP binary:', error);
  }
}

/**
 * Download, verify and install the pinned binary atomically.
 *
 * Everything happens on a temporary file next to the target: a download that
 * is interrupted must never leave a truncated file at the real path. The
 * checksum only applies here — a binary that already went through
 * `dp update` no longer matches the pinned sum.
 *
 * Order matters: the execute bit is set before the binary is run, otherwise
 * validation fails with EACCES.
 */
async function installFreshBinary(filePath: string): Promise<void> {
  const tempPath = `${filePath}.download-${process.pid}`;

  try {
    await downloadDpBinary(tempPath);
    await verifyChecksum(tempPath);
    await ensureExecutablePermissions(tempPath);

    if (!(await isDpRunnable(tempPath))) {
      throw new DpAuthServiceError(
        DpAuthError.CantInit,
        new Error('Downloaded DP binary does not run'),
      );
    }

    await fsPromises.rename(tempPath, filePath);
    logger.info('DP binary installed');
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * [nessy-fork] dp-update-fallback-workaround
 *
 * WORKAROUND: download and install a specific DP version directly.
 *
 * `dp update` (the binary's own self-update) sometimes fails on networks where
 * the direct download URL still works — it gave up on its own or timed out,
 * leaving the pinned binary in place. As a fallback we download the requested
 * version straight from the same S3-backed endpoint `installFreshBinary` uses.
 *
 * Unlike `installFreshBinary` there is no known checksum for an arbitrary
 * (newer) version, so validation is limited to "the binary actually runs".
 *
 * This is a workaround to be removed once `dp update` is fixed on such
 * networks. It never throws: failure is reported via the return value.
 *
 * @param version The version to download and install.
 * @returns true when the requested version was installed successfully.
 */
export async function installDpVersion(version: string): Promise<boolean> {
  const filePath = getDpFilePath();
  const tempPath = `${filePath}.download-${process.pid}`;

  try {
    const folderPath = getDpFolderPath();
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true, mode: 0o700 });
    }

    await downloadDpBinary(tempPath, version);
    await ensureExecutablePermissions(tempPath);

    if (!(await isDpRunnable(tempPath))) {
      logger.warn(
        `Downloaded DP ${version} does not run — discarding workaround install`,
      );
      await fsPromises.rm(tempPath, { force: true }).catch(() => {});
      return false;
    }

    await fsPromises.rename(tempPath, filePath);
    logger.info(`DP binary ${version} installed (workaround fallback)`);
    return true;
  } catch (error) {
    logger.warn(`DP ${version} direct download failed:`, error);
    await fsPromises.rm(tempPath, { force: true }).catch(() => {});
    return false;
  }
}

/**
 * Whether the binary at `filePath` actually executes.
 *
 * Deliberately does not reuse getDpVersion() from dp-api.ts: that helper calls
 * ensureDpPresence() itself, which would be circular.
 */
async function isDpRunnable(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      filePath,
      [...DP_CONFIG.versionFlagArgs],
      {
        env: {
          ...process.env,
          [DP_CONFIG.workDirEnv]: getDpFolderPath(),
        },
        signal: AbortSignal.timeout(DP_CONFIG.versionCheckTimeout),
      },
    );
    return VERSION_OUTPUT_RE.test(stdout);
  } catch (error) {
    // EACCES, ENOEXEC, ETXTBSY, timeout — all mean "not usable".
    logger.debug('DP binary version check failed:', error);
    return false;
  }
}

async function downloadDpBinary(
  destPath: string,
  version: string = DP_CONFIG.version,
): Promise<void> {
  const platform = getAvailablePlatform();
  const downloadUrl = buildDpDownloadUrl(
    DP_CONFIG.downloadUrlPrefix,
    version,
    platform,
  );

  logger.info('Downloading DP CLI from:', downloadUrl);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DP_CONFIG.downloadTimeout,
  );

  try {
    const response = await fetch(downloadUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new DpAuthServiceError(
        DpAuthError.DownloadFailed,
        new Error(`HTTP ${response.status} ${response.statusText}`),
      );
    }

    const writeStream = fs.createWriteStream(destPath, {
      encoding: 'binary',
      mode: DP_CONFIG.binaryMode,
    });
    const readableStream = stream.Readable.fromWeb(
      response.body as streamWeb.ReadableStream,
    );
    await finished(readableStream.pipe(writeStream));
    logger.info('DP CLI downloaded successfully');
  } catch (error) {
    if (error instanceof DpAuthServiceError) throw error;
    throw new DpAuthServiceError(DpAuthError.DownloadFailed, error);
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyChecksum(filePath: string): Promise<void> {
  const platform = getAvailablePlatform();
  const expectedChecksum = DP_CONFIG.md5Checksums[platform];

  const actualChecksum = await computeFileChecksum(filePath);
  if (expectedChecksum !== actualChecksum) {
    throw new DpAuthServiceError(
      DpAuthError.ChecksumMismatch,
      new Error(
        `Invalid checksum (expected ${expectedChecksum}, got ${actualChecksum})`,
      ),
    );
  }
  logger.debug('Checksum verified');
}

function computeFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', (err) =>
      reject(new DpAuthServiceError(DpAuthError.CantInit, err)),
    );
    fileStream.on('data', (chunk) => hash.update(chunk));
    fileStream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Make sure the binary carries the execute bit.
 *
 * Windows has no POSIX execute bit — `.exe` files run by extension and X_OK
 * degrades to an existence check — so the whole step is skipped there.
 *
 * Failures surface as DpAuthError.CantInit rather than a raw EPERM so that
 * prepareAuth() can tell them apart from network errors and retry.
 */
async function ensureExecutablePermissions(filePath: string): Promise<void> {
  if (getAvailablePlatform() === DpPlatform.Windows) {
    logger.debug('Skipping executable permissions on Windows');
    return;
  }

  try {
    await fsPromises.access(filePath, fs.constants.X_OK);
    return;
  } catch {
    logger.debug('DP binary is not executable — fixing permissions');
  }

  try {
    await fsPromises.chmod(filePath, DP_CONFIG.binaryMode);
    await fsPromises.access(filePath, fs.constants.X_OK);
    logger.debug('Set executable permissions on DP binary');
  } catch (error) {
    throw new DpAuthServiceError(DpAuthError.CantInit, error);
  }
}

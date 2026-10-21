/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fetch } from 'undici';
import * as tar from 'tar';
import { createDebugLogger } from '@nestor/nessy-cli-core';
import { verifySignature } from './standalone-update-verify.js';

const debugLogger = createDebugLogger('STANDALONE_UPDATE');

// [nessy-fork] standalone-update-s3-only
const S3_BASE =
  'https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/standalone';
const FETCH_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 300_000; // 5 min — archives are 50–150 MB

const VALID_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win-x64',
]);

const SEMVER_RE = /^v?\d+\.\d+\.\d+(-[\w.]+)?$/;

type UndiciResponse = Awaited<ReturnType<typeof fetch>>;

function normalizeVersion(version: string): string {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid version format: ${version}`);
  }
  // [nessy-fork] standalone-update-s3-only
  return version.replace(/^v/, '');
}

function validateTarget(target: string): void {
  if (!VALID_TARGETS.has(target)) {
    throw new Error(`Unknown target: ${target}`);
  }
}

function archiveFilename(target: string): string {
  const ext = target.startsWith('win') ? 'zip' : 'tar.gz';
  return `nessy-cli-${target}.${ext}`;
}

function escapePS(s: string): string {
  return s.replace(/'/g, "''");
}

async function tryFetch(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<
  | { response: UndiciResponse; error?: undefined }
  | { response?: undefined; error: Error }
> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { response: res };
    await res.body?.cancel().catch(() => {});
    return { error: new Error(`HTTP ${res.status} ${res.statusText}`) };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    debugLogger.debug(`Fetch failed for ${url}: ${error.message}`);
    return { error };
  }
}

// [nessy-fork] standalone-update-s3-only
export function resolveStandaloneAssetUrl(
  versionPath: string,
  filename: string,
): string {
  return `${S3_BASE}/${normalizeVersion(versionPath)}/${filename}`;
}

// [nessy-fork] standalone-update-s3-only
async function downloadFromS3(
  versionPath: string,
  filename: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<UndiciResponse> {
  const result = await tryFetch(
    resolveStandaloneAssetUrl(versionPath, filename),
    timeoutMs,
  );
  if (result.response) return result.response;

  throw new Error(
    `Failed to download ${filename} from S3: ${result.error?.message ?? 'unknown'}`,
  );
}

async function verifyChecksum(
  actualHash: string,
  filename: string,
  versionPath: string,
): Promise<void> {
  const response = await downloadFromS3(versionPath, 'SHA256SUMS');
  const text = await response.text();

  // Ed25519 signature verification of SHA256SUMS.
  // NOTE: Currently uses a test key. Once release CI signs with the production
  // key and publishes SHA256SUMS.sig, set NESSY_REQUIRE_SIGNATURE=1 to enforce.
  // Until then, verification is best-effort (passes when .sig exists, warns when not).
  const requireSig = process.env['NESSY_REQUIRE_SIGNATURE'] === '1';
  let sigResponse: UndiciResponse | undefined;
  try {
    sigResponse = await downloadFromS3(versionPath, 'SHA256SUMS.sig');
  } catch (err) {
    debugLogger.debug('SHA256SUMS.sig not available:', err);
  }
  if (sigResponse) {
    const sigContent = await sigResponse.text();
    verifySignature(text, sigContent.trim());
    debugLogger.info('SHA256SUMS signature verified.');
  } else if (requireSig) {
    throw new Error(
      'SHA256SUMS.sig not found and NESSY_REQUIRE_SIGNATURE=1 is set',
    );
  } else {
    debugLogger.warn(
      'SHA256SUMS.sig not available — update integrity relies on SHA256 checksum only. ' +
        'Set NESSY_REQUIRE_SIGNATURE=1 to enforce signature verification.',
    );
  }

  const expectedLine = text.split('\n').find((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) return false;
    // Handle GNU coreutils binary-mode prefix: "hash *filename"
    const name = parts[parts.length - 1]!.replace(/^\*/, '');
    return name === filename;
  });
  if (!expectedLine) {
    throw new Error(`No checksum found for ${filename} in SHA256SUMS`);
  }
  const expectedHash = expectedLine.trim().split(/\s+/)[0]!;

  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch: expected ${expectedHash}, got ${actualHash}`,
    );
  }
}

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024; // 512 MB

async function downloadToFile(
  versionPath: string,
  filename: string,
  destPath: string,
): Promise<string> {
  const response = await downloadFromS3(
    versionPath,
    filename,
    ARCHIVE_TIMEOUT_MS,
  );
  const body = response.body;
  if (!body) throw new Error('Empty response body');

  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
    await body.cancel().catch(() => {});
    throw new Error(
      `Download too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_BYTES} limit`,
    );
  }

  const hash = createHash('sha256');
  let bytesWritten = 0;
  const dest = fs.createWriteStream(destPath);
  const sizeGuard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_DOWNLOAD_BYTES) {
        callback(
          new Error(`Download exceeded ${MAX_DOWNLOAD_BYTES} byte limit`),
        );
      } else {
        hash.update(chunk);
        callback(null, chunk);
      }
    },
  });
  await pipeline(Readable.fromWeb(body), sizeGuard, dest);
  return hash.digest('hex');
}

function validateExtractedPaths(resolvedDest: string): void {
  const entries = fs.readdirSync(resolvedDest, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    const fullPath = path.join(
      String(entry.parentPath || entry.path),
      entry.name,
    );
    const resolved = fs.realpathSync(fullPath);
    if (
      !resolved.startsWith(resolvedDest + path.sep) &&
      resolved !== resolvedDest
    ) {
      fs.rmSync(resolvedDest, { recursive: true, force: true });
      throw new Error(
        `Path traversal detected in archive: ${entry.name} resolves to ${resolved}`,
      );
    }
  }
}

export function isSafeTarEntryPath(entryPath: string): boolean {
  if (entryPath.length === 0) return false;
  if (path.posix.isAbsolute(entryPath) || path.win32.isAbsolute(entryPath)) {
    return false;
  }
  return !entryPath.split(/[\\/]+/).includes('..');
}

async function extractArchive(
  archivePath: string,
  destDir: string,
  target: string,
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });

  if (target.startsWith('win')) {
    await new Promise<void>((resolve, reject) => {
      const ps = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${escapePS(archivePath)}' -DestinationPath '${escapePS(destDir)}' -Force`,
        ],
        { stdio: 'ignore' },
      );
      ps.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Expand-Archive exited with code ${code}`)),
      );
      ps.on('error', reject);
    });
    const resolvedDest = fs.realpathSync(destDir);
    validateExtractedPaths(resolvedDest);
  } else {
    const resolvedDest = path.resolve(destDir);
    await tar.extract({
      file: archivePath,
      cwd: destDir,
      preservePaths: false,
      filter: (p, entry) => {
        if (!isSafeTarEntryPath(p)) return false;
        if (
          'type' in entry &&
          entry.type === 'SymbolicLink' &&
          'linkpath' in entry
        ) {
          const linkTarget = path.resolve(
            resolvedDest,
            path.dirname(p),
            String(entry.linkpath),
          );
          if (
            !linkTarget.startsWith(resolvedDest + path.sep) &&
            linkTarget !== resolvedDest
          ) {
            return false;
          }
        }
        return true;
      },
    });
    // Post-extraction defense-in-depth: detect chained symlink attacks that
    // bypass the string-level filter (e.g. symlink A → ".", then A/payload → "../../etc")
    validateExtractedPaths(fs.realpathSync(destDir));
  }
}

/**
 * Runs a command and captures stdout, stderr, and exit code.
 */
function spawnAndCapture(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs },
      (err, out, stderr) => {
        if (settled) return;
        settled = true;
        if (
          err &&
          (('killed' in err && err.killed) || ('signal' in err && err.signal))
        ) {
          reject(new Error('Smoke test timed out'));
          return;
        }
        if (err) {
          const exitCode =
            'code' in err && typeof err.code === 'number' ? err.code : 1;
          resolve({ exitCode, stdout: out || '', stderr: stderr || '' });
          return;
        }
        resolve({ exitCode: 0, stdout: out || '', stderr: stderr || '' });
      },
    );
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

/**
 * Verifies the new installation can actually run by invoking --version.
 * Prevents replacing a working install with a broken binary.
 */
async function smokeTest(newInstallDir: string, target: string): Promise<void> {
  const resolvedInstallDir = path.resolve(newInstallDir);
  const nodeBin = target.startsWith('win')
    ? path.join(resolvedInstallDir, 'node', 'node.exe')
    : path.join(resolvedInstallDir, 'node', 'bin', 'node');
  const cliBin = path.join(resolvedInstallDir, 'lib', 'cli.js');

  if (!fs.existsSync(nodeBin)) {
    throw new Error(`Smoke test failed: node binary not found at ${nodeBin}`);
  }
  if (!fs.existsSync(cliBin)) {
    throw new Error(`Smoke test failed: cli.js not found at ${cliBin}`);
  }

  const { exitCode, stdout, stderr } = await spawnAndCapture(
    nodeBin,
    [cliBin, '--version'],
    10_000,
  );
  if (exitCode !== 0) {
    const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
    throw new Error(
      `Smoke test failed: new binary exited with code ${exitCode}${detail}`,
    );
  }
  const version = stdout.trim();
  if (!SEMVER_RE.test(version)) {
    throw new Error(
      `Smoke test failed: unexpected version output "${version}"`,
    );
  }
  debugLogger.info(`Smoke test passed: ${version}`);
}

function acquireLock(lockPath: string): boolean {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      const pidStr = fs.readFileSync(lockPath, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (Number.isNaN(pid) || !isProcessAlive(pid)) {
        fs.unlinkSync(lockPath);
        try {
          fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      // lock is held by another live process
    }
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

// Remove an empty standaloneDir left behind by a failed first-time migration
// (no manifest.json means it was just mkdir'd, never populated). Prevents
// permanently blocking future updates with "exists but is not a standalone install".
function cleanupEmptyStandaloneDir(standaloneDir: string): void {
  const manifestPath = path.join(standaloneDir, 'manifest.json');
  if (fs.existsSync(standaloneDir) && !fs.existsSync(manifestPath)) {
    fs.rmSync(standaloneDir, { recursive: true, force: true });
  }
}

const UNSAFE_SHELL_CHARS = /["`$\\;\n\r]/;
const UNSAFE_CMD_CHARS = /[&|<>^%!"`\n\r]/;

function assertSafeForShellEmbed(p: string, context: string): void {
  if (UNSAFE_SHELL_CHARS.test(p)) {
    throw new Error(
      `${context} contains characters unsafe for shell embedding: ${p}`,
    );
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function atomicReplace(
  standaloneDir: string,
  newDir: string,
  lockPath: string,
): 'done' | 'deferred' {
  const oldDir = `${standaloneDir}.old`;
  const pendingDir = `${standaloneDir}.new`;

  if (fs.existsSync(oldDir)) {
    fs.rmSync(oldDir, { recursive: true, force: true });
  }

  if (os.platform() === 'win32') {
    // On Windows, the running node.exe holds file locks. Stage the new dir
    // as a sibling, then spawn a helper script that waits for this process
    // to exit before completing the swap.
    // Validate paths BEFORE any filesystem mutations
    if (
      UNSAFE_CMD_CHARS.test(standaloneDir) ||
      UNSAFE_CMD_CHARS.test(oldDir) ||
      UNSAFE_CMD_CHARS.test(pendingDir)
    ) {
      throw new Error(
        'Installation path contains characters unsafe for deferred update script',
      );
    }
    if (fs.existsSync(pendingDir)) {
      fs.rmSync(pendingDir, { recursive: true, force: true });
    }
    fs.renameSync(newDir, pendingDir);

    const lockFile = lockPath;
    const logFile = path.join(path.dirname(standaloneDir), 'nessy-update.log');
    // Bat script runs detached after Node exits. It must:
    // 1. Wait for this Node process to release file locks (<= 30s).
    // 2. Run both moves with errorlevel checks; if move #2 fails, roll back
    //    move #1 so the user is never left without a working install.
    // 3. Log success/failure to nessy-update.log for post-mortem (the bat
    //    runs with stdio:ignore — the log is the only diagnostic surface).
    const script = [
      '@echo off',
      'set /a TRIES=0',
      ':wait',
      'set /a TRIES+=1',
      'if %TRIES% GTR 30 goto proceed',
      `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul && (timeout /t 1 >nul & goto wait)`,
      ':proceed',
      `echo [%DATE% %TIME%] starting swap >> "${logFile}"`,
      `move /Y "${standaloneDir}" "${oldDir}"`,
      'if errorlevel 1 goto move1_failed',
      `move /Y "${pendingDir}" "${standaloneDir}"`,
      'if errorlevel 1 goto move2_failed',
      `echo [%DATE% %TIME%] swap completed >> "${logFile}"`,
      'goto cleanup',
      ':move1_failed',
      `echo [%DATE% %TIME%] ERROR: failed to rename install to .old (errorlevel %errorlevel%) >> "${logFile}"`,
      'goto cleanup',
      ':move2_failed',
      `echo [%DATE% %TIME%] ERROR: failed to promote .new; rolling back >> "${logFile}"`,
      `move /Y "${oldDir}" "${standaloneDir}"`,
      'if errorlevel 1 (',
      `  echo [%DATE% %TIME%] CRITICAL: rollback also failed; manual recovery: move "${oldDir}" "${standaloneDir}" >> "${logFile}"`,
      ') else (',
      `  echo [%DATE% %TIME%] rollback succeeded >> "${logFile}"`,
      ')',
      ':cleanup',
      `del /F /Q "${lockFile}" 2>nul`,
      `del "%~f0"`,
    ].join('\r\n');
    const scriptPath = path.join(
      path.dirname(standaloneDir),
      'nessy-update.bat',
    );
    fs.writeFileSync(scriptPath, script);
    spawn('cmd.exe', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return 'deferred';
  } else {
    // Unix: rename is atomic on same filesystem. newDir is a sibling of
    // standaloneDir (same parent), so EXDEV won't happen.
    fs.renameSync(standaloneDir, oldDir);
    try {
      fs.renameSync(newDir, standaloneDir);
    } catch (promoteErr) {
      // Recovery rename can also fail (e.g. FS hiccup, oldDir grabbed by
      // another process). Surface BOTH errors with manual-recovery steps so
      // the user is never silently left with a missing install.
      try {
        fs.renameSync(oldDir, standaloneDir);
      } catch (rollbackErr) {
        const detail =
          `Standalone update failed AND rollback failed.\n` +
          `Original error: ${(promoteErr as Error).message}\n` +
          `Rollback error: ${(rollbackErr as Error).message}\n` +
          `Manual recovery: mv "${oldDir}" "${standaloneDir}"`;
        throw new Error(detail);
      }
      throw promoteErr;
    }
    // Keep .old for rollback instead of deleting immediately
    return 'done';
  }
}

/**
 * Ensures ~/.local/bin/nessy exists and points to the standalone install.
 * Required for npm→standalone migration so the new binary is on PATH.
 */
export function ensureBinWrapper(standaloneDir: string, target: string): void {
  const binDir = path.join(path.dirname(standaloneDir), '..', 'bin');

  try {
    fs.mkdirSync(binDir, { recursive: true });
    if (target.startsWith('win')) {
      if (UNSAFE_CMD_CHARS.test(standaloneDir)) {
        throw new Error(
          'standaloneDir contains characters unsafe for cmd.exe wrapper',
        );
      }
      const wrapperPath = path.join(binDir, 'nessy.cmd');
      if (!fs.existsSync(wrapperPath)) {
        const content = `@echo off\r\ncall "${standaloneDir}\\bin\\nessy.cmd" %*\r\n`;
        fs.writeFileSync(wrapperPath, content);
      }
    } else {
      assertSafeForShellEmbed(standaloneDir, 'standaloneDir');
      const wrapperPath = path.join(binDir, 'nessy');
      if (!fs.existsSync(wrapperPath)) {
        const content = `#!/bin/sh\nexec "${standaloneDir}/bin/nessy" "$@"\n`;
        fs.writeFileSync(wrapperPath, content, { mode: 0o755 });
      }
      ensurePathInShellRc(binDir);
    }
  } catch (err) {
    debugLogger.warn('Failed to create bin wrapper:', err);
  }
}

/**
 * Appends binDir to the user's shell rc file if not already present.
 * Mirrors the logic in install-nessy-standalone.sh maybe_update_shell_path.
 */
export function ensurePathInShellRc(binDir: string): void {
  assertSafeForShellEmbed(binDir, 'binDir');

  const shell = process.env['SHELL'] || '';
  let rcFile: string | null = null;
  const home = process.env['HOME'] || os.homedir();

  if (shell.endsWith('/zsh')) {
    rcFile = path.join(home, '.zshrc');
  } else if (shell.endsWith('/bash')) {
    const bashrc = path.join(home, '.bashrc');
    const profile = path.join(home, '.bash_profile');
    // macOS bash reads .bash_profile for login shells; Linux reads .bashrc.
    // Match install-nessy-standalone.sh's maybe_update_shell_path logic.
    if (os.platform() === 'darwin') {
      rcFile = fs.existsSync(profile) ? profile : bashrc;
    } else {
      rcFile = bashrc;
    }
  } else if (shell.endsWith('/fish')) {
    rcFile = path.join(home, '.config', 'fish', 'config.fish');
  }

  if (!rcFile) return;

  try {
    const content = fs.existsSync(rcFile)
      ? fs.readFileSync(rcFile, 'utf-8')
      : '';
    // Use a marker to detect our managed PATH entry precisely,
    // avoiding false positives from comments or $PATH-appended entries
    const marker = '# Added by Nessy CLI standalone installer';
    if (content.includes(marker)) return;

    const exportLine = shell.endsWith('/fish')
      ? `\n${marker}\nfish_add_path "${binDir}"\n`
      : `\n${marker}\nexport PATH="${binDir}:$PATH"\n`;
    fs.appendFileSync(rcFile, exportLine);
    debugLogger.info(`Added ${binDir} to ${rcFile}`);
  } catch (err) {
    debugLogger.debug('Failed to update shell rc:', err);
  }
}

/**
 * Detect the current platform target string for standalone archives.
 */
function detectTarget(): string {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  if (platform === 'win32') return 'win-x64';
  if (platform === 'linux') {
    if (arch === 'arm64') return 'linux-arm64';
    if (arch === 'x64') return 'linux-x64';
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

export async function performStandaloneUpdate(
  standaloneDir: string,
  newVersion: string,
): Promise<'done' | 'deferred'> {
  const versionPath = normalizeVersion(newVersion);

  let target: string;
  let isFirstTimeMigration = false;
  const manifestPath = path.join(standaloneDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw) as { target?: string };
    target = manifest.target ?? detectTarget();
  } else if (fs.existsSync(standaloneDir)) {
    // Directory exists but has no manifest — not a managed Nessy install.
    // Refuse to overwrite to avoid data loss.
    throw new Error(
      `${standaloneDir} exists but is not a Nessy CLI standalone install. Remove it manually to proceed.`,
    );
  } else {
    // First-time migration from npm — directory will be created after lock
    target = detectTarget();
    isFirstTimeMigration = true;
  }
  validateTarget(target);

  const filename = archiveFilename(target);
  const parentDir = path.dirname(standaloneDir);

  // Ensure the parent directory exists so the lock file can be created.
  // On first-time migration, standaloneDir (and its parent) may not exist yet.
  fs.mkdirSync(parentDir, { recursive: true });

  // Use a lockfile to prevent concurrent updates.
  // Acquire lock BEFORE creating standaloneDir to prevent a concurrent
  // process from seeing the empty directory and throwing a misleading error.
  const lockPath = path.join(parentDir, '.nessy-update.lock');
  if (!acquireLock(lockPath)) {
    throw new Error('Another update is already in progress');
  }

  if (isFirstTimeMigration) {
    fs.mkdirSync(standaloneDir, { recursive: true });
  }

  // Download to a temp dir in os.tmpdir(), then extract to a sibling dir
  // of standaloneDir to avoid EXDEV (cross-device rename).
  // extractDir uses mkdtempSync (random suffix) to prevent symlink
  // pre-creation attacks on predictable directory names.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nessy-cli-update-'));
  let extractDir: string;
  let updateResult: 'done' | 'deferred' | undefined;
  try {
    extractDir = fs.mkdtempSync(path.join(parentDir, '.nessy-cli-update-'));
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    releaseLock(lockPath);
    throw err;
  }

  try {
    const archivePath = path.join(tempDir, filename);
    debugLogger.info(`Downloading ${filename} (${versionPath})...`);
    const archiveHash = await downloadToFile(
      versionPath,
      filename,
      archivePath,
    );

    debugLogger.info('Verifying checksum...');
    await verifyChecksum(archiveHash, filename, versionPath);

    debugLogger.info('Extracting archive...');
    await extractArchive(archivePath, extractDir, target);

    const newInstallDir = path.join(extractDir, 'nessy-cli');
    if (!fs.existsSync(path.join(newInstallDir, 'manifest.json'))) {
      throw new Error(
        'Extracted archive does not contain expected nessy-cli directory',
      );
    }

    debugLogger.info('Running smoke test...');
    await smokeTest(newInstallDir, target);

    debugLogger.info('Replacing installation...');
    updateResult = atomicReplace(standaloneDir, newInstallDir, lockPath);

    // Write rollback metadata so /doctor rollback knows what version is preserved.
    // For first-time migrations, the .old dir is the empty seed directory —
    // remove it since there is no meaningful version to roll back to.
    const oldDir = `${standaloneDir}.old`;
    if (fs.existsSync(oldDir)) {
      if (isFirstTimeMigration) {
        fs.rmSync(oldDir, { recursive: true, force: true });
      } else {
        try {
          const oldManifestPath = path.join(oldDir, 'manifest.json');
          let oldVersion = 'unknown';
          if (fs.existsSync(oldManifestPath)) {
            const oldManifest = JSON.parse(
              fs.readFileSync(oldManifestPath, 'utf-8'),
            ) as { version?: string };
            oldVersion = oldManifest.version || 'unknown';
          }
          const rollbackInfo = {
            preservedVersion: oldVersion,
            updatedTo: versionPath,
            timestamp: new Date().toISOString(),
            reason: 'auto-update',
          };
          fs.writeFileSync(
            path.join(oldDir, '.nessy-rollback-info.json'),
            JSON.stringify(rollbackInfo, null, 2),
          );
        } catch {
          // Non-critical — rollback still works without metadata
        }
      }
    }

    // Ensure bin wrapper exists (critical for npm→standalone migration)
    ensureBinWrapper(standaloneDir, target);

    debugLogger.info('Standalone update complete.');
    return updateResult;
  } catch (err) {
    const pendingDir = `${standaloneDir}.new`;
    if (fs.existsSync(pendingDir)) {
      fs.rmSync(pendingDir, { recursive: true, force: true });
    }
    cleanupEmptyStandaloneDir(standaloneDir);
    throw err;
  } finally {
    // Only keep the lock alive when the bat script was spawned (deferred).
    // On failure or on Unix, release immediately.
    if (updateResult !== 'deferred') {
      releaseLock(lockPath);
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

export type RollbackResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'no-old' | 'no-manifest' | 'rename-failed';
      detail: string;
    };

/**
 * Rolls back a standalone installation to the previous version (.old directory).
 */
export function rollbackStandaloneUpdate(
  standaloneDir: string,
): RollbackResult {
  const lockPath = path.join(path.dirname(standaloneDir), '.nessy-update.lock');
  try {
    const pidStr = fs.readFileSync(lockPath, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);
    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      return {
        ok: false,
        reason: 'rename-failed',
        detail:
          'An auto-update is currently in progress. Wait for it to finish before rolling back.',
      };
    }
  } catch {
    // No lock file — safe to proceed
  }

  const oldDir = `${standaloneDir}.old`;

  if (!fs.existsSync(oldDir)) {
    return { ok: false, reason: 'no-old', detail: `${oldDir} does not exist` };
  }

  const oldManifest = path.join(oldDir, 'manifest.json');
  if (!fs.existsSync(oldManifest)) {
    debugLogger.error('Rollback failed: .old directory has no manifest.json');
    return {
      ok: false,
      reason: 'no-manifest',
      detail: `${oldDir}/manifest.json missing — .old may be corrupt`,
    };
  }

  const failedDir = `${standaloneDir}.failed`;
  try {
    if (fs.existsSync(failedDir)) {
      fs.rmSync(failedDir, { recursive: true, force: true });
    }
    fs.renameSync(standaloneDir, failedDir);
    fs.renameSync(oldDir, standaloneDir);
    debugLogger.info('Rollback successful.');
    try {
      fs.rmSync(failedDir, { recursive: true, force: true });
    } catch {
      debugLogger.debug(`Leftover .failed dir at ${failedDir}, safe to delete`);
    }
    return { ok: true };
  } catch (err) {
    debugLogger.error('Rollback failed:', err);
    // Attempt to restore current if we moved it
    if (!fs.existsSync(standaloneDir) && fs.existsSync(failedDir)) {
      try {
        fs.renameSync(failedDir, standaloneDir);
        return {
          ok: false,
          reason: 'rename-failed',
          detail: `Filesystem error: ${(err as Error).message}. Current installation was restored automatically.`,
        };
      } catch {
        // Critical failure — both dirs are in bad state
      }
    }
    return {
      ok: false,
      reason: 'rename-failed',
      detail: `Filesystem error: ${(err as Error).message}. Manual recovery: mv "${oldDir}" "${standaloneDir}"`,
    };
  }
}

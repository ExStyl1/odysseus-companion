/**
 * DP CLI self-update.
 * Runs `dp update` so the managed binary is not left on the pinned version.
 */

// [nessy-fork] dp-binary-lifecycle

import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getPty, type PtyProcess } from '../utils/getPty.js';
import {
  DP_CONFIG,
  getDpFilePath,
  getDpFolderPath,
} from './dp-config.js';

const execFileAsync = promisify(execFileCallback);
const logger = createDebugLogger('DP_UPDATE');

/** Marker dp prints when a newer version is available. */
const UPDATE_AVAILABLE_RE = /dp update available from (\d+\.\d+\.\d+) to (\d+\.\d+\.\d+)/i;

let updateRequest: Promise<boolean> | undefined;

/**
 * Best-effort self-update of the DP CLI binary.
 *
 * Skips only when the binary is not installed (no implicit download here).
 * The update runs on every startup so DP can check for a newer version.
 *
 * Never throws. Failure is reported via the return value. A failed update may
 * be caused by a transient network error and does not make the installed
 * binary unusable.
 *
 * Concurrent callers share a single inflight update; running two `dp update`
 * processes over the same file would race for the binary being replaced.
 *
 * @returns true when `dp update` completed successfully.
 */
export async function tryAsyncDpUpdate(): Promise<boolean> {
  if (updateRequest) {
    return updateRequest;
  }
  updateRequest = runUpdate();
  try {
    return await updateRequest;
  } finally {
    updateRequest = undefined;
  }
}

/**
 * Version pair reported by dp when a newer release is available.
 */
export interface DpUpdateInfo {
  /** Currently installed version. */
  current: string;
  /** Latest available version. */
  latest: string;
}

/**
 * Run `command` inside a pseudo-TTY and resolve with its captured output.
 *
 * dp only prints its "update available" notice when stdout is an interactive
 * terminal, so a plain subprocess with piped stdout would never show the
 * marker. Running dp under a PTY makes it think it is interactive, and the
 * captured output is only consumed by the update check — never shown to the
 * user directly.
 *
 * Falls back to a non-PTY run when no PTY implementation is available (e.g.
 * Windows, or a runtime that cannot load node-pty). Returns null on failure
 * (nonzero exit, timeout, or no output); the caller treats that as "no
 * update info".
 */
async function runDpInPty(): Promise<string | null> {
  const dpPath = getDpFilePath();

  const pty = await getPty();
  if (!pty) {
    logger.debug('No PTY available — running dp without one');
    try {
      const { stdout, stderr } = await execFileAsync(dpPath, [], {
        env: {
          ...process.env,
          [DP_CONFIG.workDirEnv]: getDpFolderPath(),
        },
        signal: AbortSignal.timeout(DP_CONFIG.versionCheckTimeout),
      });
      return cleanPtyOutput(`${stdout}\n${stderr}`);
    } catch (err) {
      logger.debug('dp update check failed (no PTY):', err);
      return null;
    }
  }

  const module = pty.module as {
    spawn: (
      file: string,
      args: string[],
      options: {
        name: string;
        cols: number;
        rows: number;
        cwd: string;
        env: NodeJS.ProcessEnv;
      },
    ) => PtyProcess;
  };

  return new Promise<string | null>((resolve) => {
    let output = '';
    let settled = false;
    let ptyProc: PtyProcess | undefined;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ptyProc?.kill();
      logger.debug('dp update check timed out');
      resolve(null);
    }, DP_CONFIG.versionCheckTimeout);

    try {
      ptyProc = module.spawn(dpPath, [], {
        name: 'xterm-color',
        cols: 120,
        rows: 40,
        cwd: getDpFolderPath(),
        env: {
          ...process.env,
          [DP_CONFIG.workDirEnv]: getDpFolderPath(),
        },
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      logger.debug('dp update check spawn failed:', err);
      resolve(null);
      return;
    }

    ptyProc.onData((data: string) => {
      output += data;
    });
    ptyProc.onExit(({ exitCode }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (exitCode !== 0) {
        logger.debug(`dp update check exited with code ${exitCode}`);
        resolve(null);
        return;
      }
      resolve(cleanPtyOutput(output));
    });
  });
}

/** Strips terminal control characters and CR from pty-captured output. */
function cleanPtyOutput(output: string): string {
  let cleaned = '';
  for (const char of output) {
    const code = char.charCodeAt(0);
    if (code === 13) continue; // CR
    if (code < 32 && code !== 9 && code !== 10) continue; // control chars
    if (code === 127) continue; // DEL
    cleaned += char;
  }
  return cleaned;
}

/** Parses the "update available" marker from raw dp output. */
export function parseDpUpdateInfo(output: string): DpUpdateInfo | null {
  const match = UPDATE_AVAILABLE_RE.exec(cleanPtyOutput(output));
  if (!match) return null;
  return { current: match[1], latest: match[2] };
}

/**
 * Whether a newer DP CLI version is available, and if so, which versions are
 * involved.
 *
 * The only way to learn this is to run dp: a bare `dp` invocation prints
 * `dp update available from <current> to <latest>` at the top of its output
 * when the binary lags behind the latest release (a plain `dp version` stays
 * clean). dp only prints this notice when stdout is an interactive terminal,
 * so the check runs dp under a PTY (`node-pty`) to capture it from a
 * non-interactive subprocess. The bare invocation is quick (it does not
 * download the binary).
 *
 * Never throws. Returns null when the binary is absent, no update is
 * available, or the check fails.
 */
export async function checkForDpUpdateAvailable(): Promise<DpUpdateInfo | null> {
  const dpPath = getDpFilePath();
  if (!fs.existsSync(dpPath)) {
    logger.debug('DP binary not present — skipping update check');
    return null;
  }

  try {
    logger.debug('Checking for dp update');
    const combined = await runDpInPty();
    if (!combined) {
      return null;
    }
    const info = parseDpUpdateInfo(combined);
    if (!info) {
      logger.debug('dp update check: no newer version');
      return null;
    }
    logger.debug('dp update check result:', info);
    return info;
  } catch (err) {
    logger.debug('dp update check failed:', err);
    return null;
  }
}

async function runUpdate(): Promise<boolean> {
  const dpPath = getDpFilePath();
  if (!fs.existsSync(dpPath)) {
    logger.debug('DP binary not present — skipping update');
    return false;
  }

  try {
    logger.info('Running dp update');
    await execFileAsync(dpPath, [...DP_CONFIG.updateArgs], {
      env: {
        ...process.env,
        [DP_CONFIG.workDirEnv]: getDpFolderPath(),
      },
      signal: AbortSignal.timeout(DP_CONFIG.updateTimeout),
    });
    logger.info('dp update completed');
    return true;
  } catch (err) {
    logger.warn('dp update failed:', err);
    return false;
  }
}

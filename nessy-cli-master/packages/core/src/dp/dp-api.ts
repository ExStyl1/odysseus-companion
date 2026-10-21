/**
 * DP CLI command executor.
 * Ported from assistant's auth/dp-api.ts.
 */

import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
import { createDebugLogger } from '../utils/debugLogger.js';
import { DP_CONFIG, getDpFilePath, getDpFolderPath } from './dp-config.js';
import { DpAuthError, DpAuthServiceError } from './dp-errors.js';
import { ensureDpPresence } from './dp-downloader.js';

// [nessy-fork] dp-binary-lifecycle
const execFileAsync = promisify(execFileCallback);
const logger = createDebugLogger('DP');

function buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [DP_CONFIG.workDirEnv]: getDpFolderPath(),
    ...extra,
  };
}

export async function getDpVersion(): Promise<string> {
  const dpPath = getDpFilePath();

  if (!fs.existsSync(dpPath)) {
    logger.info('Downloaded DP binary not found, ensuring presence...');
    await ensureDpPresence();
  }

  const { stdout } = await execFileAsync(dpPath, [...DP_CONFIG.versionArgs], {
    env: buildEnv(),
  });
  const match = stdout.match(/Spirit CLI Version: (\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

export async function getDpToken(): Promise<string | undefined> {
  const dpPath = getDpFilePath();

  if (!fs.existsSync(dpPath)) {
    logger.info('Downloaded DP binary not found, ensuring presence...');
    await ensureDpPresence();
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      dpPath,
      [...DP_CONFIG.printTokenArgs],
      {
        env: buildEnv(),
        signal: AbortSignal.timeout(DP_CONFIG.printTokenTimeout),
      },
    );

    const stdoutLines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
    const stderrLines = stderr
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((str) => str.trim());

    if (
      stdoutLines.length === 1 &&
      stderrLines.length === 0 &&
      stdout.length > 0
    ) {
      return stdout.trim();
    }
  } catch (error: unknown) {
    const needLoginMessage =
      'no access token found, you need to authorize user or service account first';
    if (
      typeof error === 'object' &&
      error !== null &&
      'stderr' in error &&
      typeof (error as { stderr: unknown }).stderr === 'string' &&
      (error as { stderr: string }).stderr.includes(needLoginMessage)
    ) {
      return undefined;
    }
    throw error;
  }

  return undefined;
}

export async function dpLogin(options: { isWsl: boolean }): Promise<void> {
  const dpPath = getDpFilePath();

  if (!fs.existsSync(dpPath)) {
    logger.info('Downloaded DP binary not found, ensuring presence...');
    await ensureDpPresence();
  }

  const env = buildEnv(options.isWsl ? { BROWSER: 'wslview' } : undefined);

  logger.info('Executing dp auth login...');
  const { stdout, stderr } = await execFileAsync(
    dpPath,
    [...DP_CONFIG.loginArgs],
    { env, signal: AbortSignal.timeout(60_000) },
  );

  const successRegex = /user ".*" successfully authorized/;
  if (!successRegex.test(stdout)) {
    throw new DpAuthServiceError(DpAuthError.CantLogin, new Error(stderr));
  }
  logger.info('DP login succeeded');
}

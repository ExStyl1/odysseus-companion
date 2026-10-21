/**
 * DP Authentication manager with retry logic.
 * Ported from assistant's auth/dp-auth-manager.ts.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { ensureDpPresence, removeDp } from './dp-downloader.js';
import { getDpToken, dpLogin } from './dp-api.js';
import { DpAuthError, DpAuthServiceError } from './dp-errors.js';
import { isRunningInWSL, isWSLViewInstalled } from './wsl-detection.js';

const logger = createDebugLogger('DP');

// [nessy-fork] dp-auth
let tokenRequest: Promise<string | undefined> | undefined;
let performDpAuthRequest: Promise<string> | undefined;

/**
 * Ensure DP binary is present, with retry after cleanup on failure.
 */
export async function prepareAuth(): Promise<void> {
  try {
    await ensureDpPresence();
    return;
  } catch (e) {
    logger.info('prepareAuth error; deleting dp and trying again');
    logger.error('prepareAuth first attempt:', e);
  }

  try {
    removeDp();
    await ensureDpPresence();
  } catch (e) {
    logger.error('prepareAuth error after retrying; giving up:', e);
    throw e;
  }
}

/**
 * Try to get DP token. Returns undefined if no token is available (not logged in).
 * Uses request deduplication (single inflight promise).
 */
async function tryGetToken(): Promise<string | undefined> {
  logger.info('Getting dp token');

  try {
    if (!tokenRequest) {
      tokenRequest = getDpToken();
    }

    const token = await tokenRequest;
    tokenRequest = undefined;
    return token;
  } catch (error) {
    tokenRequest = undefined;
    if (error instanceof DpAuthServiceError) {
      throw error;
    }
    throw new DpAuthServiceError(DpAuthError.ExecDp, error);
  }
}

/**
 * Get DP token with request deduplication. Throws if no token available.
 */
export async function getToken(): Promise<string> {
  const token = await tryGetToken();
  if (token !== undefined) {
    return token;
  }
  throw new DpAuthServiceError(DpAuthError.ExecDp);
}

/**
 * Execute DP login flow.
 */
export async function login(options: { isWsl: boolean }): Promise<void> {
  try {
    await dpLogin(options);
  } catch (error) {
    logger.error('login failed:', error);
    throw new DpAuthServiceError(DpAuthError.CantLogin, error);
  }
}

/**
 * Performs DP authentication flow and returns DP token.
 * This function handles:
 *   - DP binary preparation
 *   - WSL detection
 *   - Interactive login via browser
 *   - Token retrieval
 *
 * Does NOT exchange the token for JWT - use performNessyAuth() for that.
 *
 * Single-flight: concurrent callers share one inflight auth attempt. This
 * prevents racing dp binary invocations (e.g. startup auth + gitlab extension
 * fetch) from triggering duplicate downloads or browser logins.
 *
 * @returns DP token string for use in GitLab and other external services
 * @throws DpAuthServiceError if authentication fails
 */
export async function performDpAuth(): Promise<string> {
  if (performDpAuthRequest) {
    return performDpAuthRequest;
  }
  performDpAuthRequest = performDpAuthImpl();
  try {
    return await performDpAuthRequest;
  } finally {
    performDpAuthRequest = undefined;
  }
}

async function performDpAuthImpl(): Promise<string> {
  // 1. Download/verify DP binary
  logger.info('Preparing DP binary...');
  await prepareAuth();

  // 2. WSL detection
  const wsl = isRunningInWSL();
  const useWsl = wsl && (await isWSLViewInstalled());
  logger.info(`WSL detected: ${wsl}, use wslview: ${useWsl}`);

  // 3. Print CLI message about browser redirect
  // process.stderr.write(
  //   '\nDP Authentication: A browser window will open for you to authenticate.\n' +
  //     'If the browser does not open automatically, please check the terminal output.\n\n',
  // );
  let dpToken = await tryGetToken();
  if (!dpToken) {
    // 4. dp auth login
    logger.info('Starting DP login...');
    await login({ isWsl: useWsl });

    // 5. dp auth print-token
    logger.info('Retrieving DP token...');
    dpToken = await getToken();
  }
  logger.info('DP token retrieved successfully');
  return dpToken;
}

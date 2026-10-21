/**
 * DP Authentication service — main entry point for Nessy CLI.
 * Orchestrates the full authentication flow:
 *   cached credentials → DP binary → WSL detection → login → token exchange → JWT decode → save
 */

import * as crypto from 'node:crypto';
import { createDebugLogger } from '../utils/debugLogger.js';
import { performDpAuth as performDpAuthInternal } from './dp-auth-manager.js';
import { exchangeToken } from './dp-token-exchange-client.js';
import { decodeJwt } from './jwt-decoder.js';
import { fetchModels } from './dp-models-client.js';
import type { ModelConfig } from '../models/types.js';
import type { Config } from '../config/config.js';
import { tryAuthFromEnv } from './dp-delegated-token.js';
import { cacheNessyCredentials, type NessyCredentials } from '../qwen/qwenOAuth2.js';

const logger = createDebugLogger('DP');

export interface DpAuthResult {
  jwt: string;
  expiresAt: number;
  username: string;
  userId: string;
  models: ModelConfig[];
}

// [nessy-fork] dp-auth
/**
 * Performs full Nessy authentication flow with JWT token exchange.
 * Returns credentials and fetched models.
 * @returns DpAuthResult with JWT token, user information, and models
 */
export async function performNessyAuth(config?: Config): Promise<DpAuthResult> {

  // [nessy-fork] dp-auth-runtime-model-catalog
  // 0. Env-token bypass: if NESSY_CLI_DP_AUTH_TOKEN is set, use it directly
  const envCreds = await tryAuthFromEnv();
  if (envCreds) {
    // Fetch models for env-token auth
    try {
      logger.info('Fetching models for env-token auth...');
      const models = await fetchModels(envCreds.jwt, undefined, config);
      logger.info(`Fetched ${models.length} DP models`);
      return { ...envCreds, models };
    } catch (error) {
      logger.error('Failed to fetch models for env-token:', error);
      return { ...envCreds, models: [] };
    }
  }

  // 1. Perform DP auth (prepare binary, WSL detection, login, get token)
  logger.info('Starting DP authentication flow...');
  const dpToken = await performDpAuthInternal();

  // 8. Exchange DP token for JWT via POST /api/v2/token
  const requestId = crypto.randomUUID();
  const tokenResponse = await exchangeToken(
    requestId,
    dpToken,
    undefined,
    config,
  );

  // 9. Decode JWT for username/userId
  const jwt = decodeJwt(tokenResponse.jwt);
  const username = jwt.preferred_username || '';
  const userId = jwt.sub || '';

  // 10. Build credentials (do NOT save to dp_auth_creds.json - use shared oauth_creds.json instead)
  const credentials: DpAuthResult = {
    jwt: tokenResponse.jwt,
    expiresAt: jwt.exp * 1000, // convert seconds to ms
    username,
    userId,
    models: [], // Will be populated in step 11
  };

  logger.info(`Nessy authentication succeeded for user: ${username}`);

  // Save JWT to shared OAuth credentials store (same as Qwen auth)
  try {
    const nessyCreds: NessyCredentials = {
      access_token: tokenResponse.jwt,
      expiry_date: jwt.exp * 1000,
      token_type: 'Bearer',
    };
    await cacheNessyCredentials(nessyCreds);
    logger.info('Saved JWT to shared OAuth credentials store (oauth_creds.json)');
  } catch (error) {
    logger.error('Failed to save JWT to shared store:', error);
    throw error; // Fatal - cannot proceed without credentials
  }

  // 11. Fetch models from the server (always, even for fresh auth)
  // [nessy-fork] model-alias-fast
  try {
    logger.info('Fetching DP models...');
    const models = await fetchModels(tokenResponse.jwt, undefined, config);
    logger.info(`Fetched ${models.length} DP models`);
    credentials.models = models;
  } catch (error) {
    logger.error('Failed to fetch DP models:', error);
    // Non-fatal error - continue without models
  }

  return credentials;
}

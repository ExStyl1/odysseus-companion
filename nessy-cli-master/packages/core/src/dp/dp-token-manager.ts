/**
 * DP token storage and cache manager.
 * Stores credentials to ~/.nessy/dp_auth_creds.json with in-memory cache.
 * Combines patterns from assistant's loginDataKeeper.ts and fsTokenStorage.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getDpCredentialsPath } from './dp-config.js';
import type { ModelConfig } from '../models/types.js';

const logger = createDebugLogger('DP');

// [nessy-fork] dp-auth
export interface DpCredentials {
  jwt: string;
  expiresAt: number; // epoch ms
  username: string;
  userId: string;
  /** Cached models from the server (optional, for offline fallback) */
  cachedModels?: ModelConfig[];
}

let cachedCredentials: DpCredentials | null = null;

export function getValidCredentials(): DpCredentials | null {
  const creds = getCachedOrLoadCredentials();
  if (creds && creds.expiresAt > Date.now()) {
    return creds;
  }
  return null;
}

/**
 * Populate the in-memory credentials cache without itself writing to disk.
 *
 * Intended for the env-token (NESSY_CLI_DP_AUTH_TOKEN) session flow
 * Do not use this as a general "save" — use `saveCredentials` for that.
 */
// [nessy-fork] delegated-token-auth
export function setTransientCredentialsInMemory(
  credentials: DpCredentials,
): void {
  cachedCredentials = credentials;
}

export function saveCredentials(credentials: DpCredentials): void {
  cachedCredentials = credentials;

  const filePath = getDpCredentialsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const content = JSON.stringify(credentials, null, 2);
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  logger.info('Saved DP credentials');
}

/**
 * Save only the cached models to the credentials file.
 * This is used to update the models cache without re-saving all credentials.
 * @param models - Array of model configurations to cache
 */
export function saveDpModelsCache(models: ModelConfig[]): void {
  logger.info(`saveDpModelsCache: called with ${models.length} models`);
  const creds = getCachedOrLoadCredentials();
  if (creds) {
    logger.info('saveDpModelsCache: credentials loaded, updating cachedModels');
    creds.cachedModels = models;
    cachedCredentials = creds;

    const filePath = getDpCredentialsPath();
    logger.info(`saveDpModelsCache: writing to ${filePath}`);
    const content = JSON.stringify(creds, null, 2);
    fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
    logger.info(`Saved ${models.length} DP models to cache`);
  } else {
    logger.warn('saveDpModelsCache: no credentials found, cannot save models');
  }
}

export function loadCredentials(): DpCredentials | null {
  const filePath = getDpCredentialsPath();
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as DpCredentials;
    if (data.jwt && typeof data.expiresAt === 'number') {
      cachedCredentials = data;
      return data;
    }
    return null;
  } catch {
    logger.warn('Failed to load DP credentials from file');
    return null;
  }
}

export function clearCredentials(): void {
  cachedCredentials = null;
  const filePath = getDpCredentialsPath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logger.info('Cleared DP credentials');
  }
}

/**
 * Clear credentials and models cache file.
 * Used for forced re-login to ensure fresh authentication.
 */
export function clearCredentialsFile(): void {
  const filePath = getDpCredentialsPath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logger.info('Cleared DP credentials file for forced re-login');
  }
  cachedCredentials = null;
}

function getCachedOrLoadCredentials(): DpCredentials | null {
  if (cachedCredentials) {
    return cachedCredentials;
  }
  return loadCredentials();
}

/**
 * Get cached models from credentials file.
 * @returns Array of cached model configurations, or null if not available
 */
export function getCachedModels(): ModelConfig[] | null {
  const creds = getCachedOrLoadCredentials();
  return creds?.cachedModels ?? null;
}

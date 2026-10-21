/**
 * DP Authentication module barrel exports.
 */

// [nessy-fork] dp-auth
export { DpAuthError, DpAuthServiceError } from './dp-errors.js';
export {
  DpPlatform,
  DP_CONFIG,
  getAvailablePlatform,
  dpBaseName,
  buildDpDownloadUrl,
  getDpFolderPath,
  getDpFilePath,
  getDpCredentialsPath,
} from './dp-config.js';
export { ensureDpPresence, removeDp, installDpVersion } from './dp-downloader.js';
export { tryAsyncDpUpdate, checkForDpUpdateAvailable, type DpUpdateInfo } from './dp-updater.js';
export { getDpVersion, getDpToken, dpLogin } from './dp-api.js';
export { prepareAuth, getToken, login } from './dp-auth-manager.js';
export { exchangeToken, type TokenResponse } from './dp-token-exchange-client.js';
export { decodeJwt, type JwtPayload } from './jwt-decoder.js';
export {
  getValidCredentials,
  saveCredentials,
  loadCredentials,
  clearCredentials,
  clearCredentialsFile,
  getCachedModels,
  saveDpModelsCache,
  type DpCredentials,
} from './dp-token-manager.js';
export { isRunningInWSL, isWSLViewInstalled } from './wsl-detection.js';
export { performNessyAuth, type DpAuthResult } from './dp-auth-service.js';
export { performDpAuth } from './dp-auth-manager.js';
// DpContentGenerator is NOT exported here to avoid circular dependency
// It is exported directly from dp-content-generator.js when needed
export {
  fetchModels,
  loadDpModelsFromServer,
  refreshDpModelsCache,
} from './dp-models-client.js';
export { buildNestorAuthHeaders } from './nestor-auth-header.js';
export {
  fetchUserQuota,
  UserQuotaUnavailableError,
  type UserQuota,
  type UserQuotaDescriptionPart,
  type UserQuotaDisplay,
  type UserQuotaScope,
  type UserQuotaSnapshot,
  type UserQuotaStatus,
} from './user-quota-client.js';

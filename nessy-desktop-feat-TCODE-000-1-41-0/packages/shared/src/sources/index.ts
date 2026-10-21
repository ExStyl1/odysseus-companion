/**
 * Sources Module
 *
 * Public exports for source management.
 */

// Types
export type {
  SourceType,
  SourceMcpAuthType,
  ApiAuthType,
  KnownProvider,
  ApiOAuthProvider,
  ApiOAuthConfig,
  McpSourceConfig,
  ApiSourceConfig,
  LocalSourceConfig,
  SourceConnectionStatus,
  FolderSourceConfig,
  SourceGuide,
  LoadedSource,
  CreateSourceInput,
  ApiRenewEndpoint,
} from './types.ts';

// Constants and helpers
export { removeSourceEverywhere, type RemoveSourceDeps } from './removal.ts';

export {
  API_OAUTH_PROVIDERS,
  isApiOAuthProvider,
  isGenericOAuthSource,
  hasRenewEndpoint,
  isRefreshableSource,
} from './types.ts';

// Storage functions
export {
  // Directory utilities
  ensureSourcesDir,
  getSourcePath,
  // Config operations
  loadSourceConfig,
  saveSourceConfig,
  markSourceAuthenticated,
  // Guide operations
  loadSourceGuide,
  saveSourceGuide,
  // Icon operations
  findSourceIcon,
  downloadSourceIcon,
  sourceNeedsIconDownload,
  isIconUrl,
  // Load operations
  loadSource,
  loadWorkspaceSources,
  loadAllSources,
  getEnabledSources,
  isSourceUsable,
  extractTagline, // UB6.14 — the tagline helper the suggestions candidates read (upstream exports it; ours never had a reader)
  getSourcesBySlugs,
  // Create/Delete operations
  generateSourceSlug,
  createSource,
  deleteSource,
  sourceExists,
  // Parsing utilities
  parseGuideMarkdown,
} from './storage.ts';

// Credential Manager (unified credential operations)
export {
  CONNECTOR_GLOBAL_CREDENTIAL_SCOPE,
  connectorGlobalCredentialScope,
  SourceCredentialManager,
  getSourceCredentialManager,
  getSourcesNeedingAuth,
  sourceCredentialScope,
  sourceSupportsAuthentication,
  // UB3.1 (OSS #1067) — the shared API-credential parser/serializer, re-exported
  // from `@nessy-agent/session-tools-core/api-auth` via credential-manager.ts.
  isMultiHeaderCredential,
  parseStoredApiCredential,
  serializeHeaderCredential,
} from './credential-manager.ts';

// Removal-only migration support for retired plaintext credential caches.
export {
  SOURCE_CREDENTIAL_CACHE_FILENAME,
  legacySourceCredentialCachePath,
  deleteLegacySourceCredentialCache,
  deleteLegacySourceCredentialCaches,
} from './credential-cache.ts';
export type {
  LegacySourceCredentialCacheLocation,
} from './credential-cache.ts';
export type {
  AuthResult,
  ApiCredential,
  BasicAuthCredential,
  MultiHeaderCredential,
} from './credential-manager.ts';

// Server Builder (builds MCP/API servers from sources)
export {
  SourceServerBuilder,
  getSourceServerBuilder,
  normalizeMcpUrl,
  SERVER_BUILD_ERRORS,
} from './server-builder.ts';
export type {
  McpServerConfig,
  SourceWithCredential,
  BuiltServers,
} from './server-builder.ts';


// API Tools (types)
export type { SummarizeCallback } from './api-tools.ts';

// Token Refresh Manager (handles OAuth token refresh with rate limiting)
export {
  TokenRefreshManager,
  createTokenGetter,
} from './token-refresh-manager.ts';
export type {
  TokenRefreshResult,
  RefreshManagerOptions,
} from './token-refresh-manager.ts';

// UA9.2 — the API fetch path the Pages action bridge's API executor takes (v0.13.4 sources/index.ts L96 adapted)
export {
  executeApiRequest,
  ApiResponseTooLargeError,
  type ApiRequestInput,
  type ApiRequestOutcome,
  type ExecuteApiRequestOptions,
  type ApiCredentialSource,
} from './api-tools.ts';

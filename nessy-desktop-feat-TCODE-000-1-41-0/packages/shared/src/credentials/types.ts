/**
 * Credential Storage Types
 *
 * Defines the types for secure credential storage using AES-256-GCM encryption.
 * Supports global, connection, workspace, and source-scoped credentials.
 *
 * Credential key format: "{type}::{scope...}"
 *
 * Examples:
 *   - anthropic_api_key::global
 *   - decision_api_key::{provider}
 *   - claude_oauth::global
 *   - source_oauth::{workspaceId}::{sourceId}
 *   - source_bearer::{workspaceId}::{sourceId}
 *
 * Note: Using "::" as delimiter to avoid conflicts with "/" in URLs or paths.
 */

/** Types of credentials we store */
export type CredentialType =
  // Global credentials (legacy, kept for backwards compatibility)
  | 'anthropic_api_key'  // Anthropic API key for Claude
  | 'claude_oauth'       // Claude OAuth token (Max subscription)
  | 'telemetry_salt' | 'host_approvals_key' // Per-install telemetry pseudonymization salt; UA1.10 per-install HMAC key of the host-approvals ledger (approvals/host-approvals.ts) — headless only since UA12.1 (the desktop seals its key with the OS secret store)
  // LLM connection credentials (keyed by connection slug)
  | 'llm_api_key'        // API key for LLM connection
  | 'llm_oauth'          // OAuth token for LLM connection
  | 'llm_iam'            // AWS IAM credentials (accessKeyId + secretAccessKey)
  | 'llm_service_account' // GCP service account JSON
  // Workspace credentials
  | 'workspace_oauth'    // Workspace MCP OAuth token
  | 'remote_server_token' // Remote Nessy server token, keyed by local Workspace ID
  // Source credentials (secure backend, keyed by Workspace ID and source slug)
  | 'source_oauth'       // OAuth tokens for MCP/API sources
  | 'source_bearer'      // Bearer tokens
  | 'source_apikey'      // API keys
  | 'source_basic'       // Basic auth (base64 encoded user:pass)
  // Plugin MCP server credentials (global — one credential per server, ever,
  // in every workspace; keyed by {pluginKey, serverName}; capability-path ADR § 2)
  | 'plugin_mcp_oauth'   // OAuth tokens for plugin-declared MCP servers
  | 'plugin_mcp_bearer' // Bearer tokens for plugin-declared MCP servers
  // UB6.1 (DEC-0) — decision layer (Jev / System One) API key, keyed by decision
  // provider id via `name` (decision_api_key::{provider})
  | 'decision_api_key';

/** Valid credential types for validation */
const VALID_CREDENTIAL_TYPES: readonly CredentialType[] = [
  'anthropic_api_key',
  'claude_oauth',
  'telemetry_salt', 'host_approvals_key',
  'llm_api_key',
  'llm_oauth',
  'llm_iam',
  'llm_service_account',
  'workspace_oauth',
  'remote_server_token',
  'source_oauth',
  'source_bearer',
  'source_apikey',
  'source_basic',
  'plugin_mcp_oauth',
  'plugin_mcp_bearer',
  'decision_api_key',
] as const;

/** Check if a string is a valid CredentialType */
function isValidCredentialType(type: string): type is CredentialType {
  return VALID_CREDENTIAL_TYPES.includes(type as CredentialType);
}

/** Credential identifier - determines credential store entry key */
export interface CredentialId {
  type: CredentialType;

  // LLM connection-scoped format
  /** LLM connection slug for llm_api_key/llm_oauth credentials */
  connectionSlug?: string;

  // Workspace-scoped format
  /** Workspace ID for workspace-scoped credentials */
  workspaceId?: string;
  /** Source ID for source credentials */
  sourceId?: string;
  /** Server name or API name */
  name?: string;

  // Plugin MCP server-scoped format (global; plugin_mcp_* credentials)
  /** Stable version-less plugin key for plugin_mcp_* credentials */
  pluginKey?: string;
  /** Declared MCP server name within the plugin for plugin_mcp_* credentials */
  serverName?: string;
}

/**
 * Stored credential value in encrypted file.
 *
 * This is a generic type for all credential types (OAuth, bearer tokens, API keys, IAM, service accounts).
 * All fields except `value` are optional since not all credential types use them.
 *
 * Note: `clientId` is optional here unlike `OAuthCredentials` (in storage.ts)
 * where it's required, because this type also covers bearer tokens and API keys
 * which don't have a clientId.
 */
export interface StoredCredential {
  /** The secret value (API key, access token, or primary credential) */
  value: string;
  /** OAuth refresh token */
  refreshToken?: string;
  /** OAuth token expiration (Unix timestamp ms) */
  expiresAt?: number;
  /** OAuth client ID (needed for token refresh) */
  clientId?: string;
  /** OAuth client secret (needed for Google token refresh - Google requires both ID and secret) */
  clientSecret?: string;
  /** Token type (e.g., "Bearer") */
  tokenType?: string;
  /** Where the credential came from: 'native' (our OAuth), 'cli' (Claude CLI import) */
  source?: 'native' | 'cli';
  /**
   * OIDC id_token (JWT with user identity claims).
   * Used by OpenAI/Codex which returns both id_token and access_token.
   * The `value` field stores access_token, this field stores id_token.
   */
  idToken?: string;

  // --- AWS IAM credentials (for llm_iam type) ---

  /** AWS Access Key ID (for IAM credentials) */
  awsAccessKeyId?: string;
  /** AWS Secret Access Key (for IAM credentials) - stored in `value` field */
  // awsSecretAccessKey is stored in the `value` field
  /** AWS Region (for IAM credentials) */
  awsRegion?: string;
  /** AWS Session Token (for temporary credentials) */
  awsSessionToken?: string;

  // --- GCP Service Account (for llm_service_account type) ---

  /** GCP Project ID (for service account) */
  gcpProjectId?: string;
  /** GCP Region (for service account) */
  gcpRegion?: string;
  /** Service account email (for identification) */
  serviceAccountEmail?: string;
  // Full service account JSON is stored in the `value` field
}

// Using "::" as delimiter instead of "/" because server names and API names
// could contain "/" (e.g., URLs like "https://api.example.com")
const CREDENTIAL_DELIMITER = '::';

/** Source credential types */
export const SOURCE_CREDENTIAL_TYPES = [
  'source_oauth',
  'source_bearer',
  'source_apikey',
  'source_basic',
] as const;

/**
 * Plugin MCP server credential types (capability-path ADR § 2).
 * Account shape: `{type}::{pluginKey}::{serverName}` — global by construction,
 * matching the contract's model: one credential per server, centrally, with no
 * per-workspace duplication concept.
 */
export const PLUGIN_MCP_CREDENTIAL_TYPES = [
  'plugin_mcp_oauth',
  'plugin_mcp_bearer',
] as const;

/** Check if type is a plugin MCP server credential */
function isPluginMcpCredential(type: CredentialType): boolean {
  return (PLUGIN_MCP_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** UB6.1 — decision-layer credential (decision provider id via `name`) */
function isDecisionCredential(type: CredentialType): boolean {
  return type === 'decision_api_key';
}

/** LLM connection credential types */
const LLM_CREDENTIAL_TYPES = [
  'llm_api_key',
  'llm_oauth',
  'llm_iam',
  'llm_service_account',
] as const;

/** Check if type is a source credential */
function isSourceCredential(type: CredentialType): boolean {
  return (SOURCE_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** Check if type is an LLM connection credential */
function isLlmCredential(type: CredentialType): boolean {
  return (LLM_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** Convert CredentialId to credential store account string */
export function credentialIdToAccount(id: CredentialId): string {
  const parts: string[] = [id.type];

  // LLM connection-scoped format:
  // llm_api_key::{connectionSlug}
  // llm_oauth::{connectionSlug}
  if (isLlmCredential(id.type) && id.connectionSlug) {
    parts.push(id.connectionSlug);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Workspace-scoped format (no source):
  // workspace_oauth::{workspaceId}
  if ((id.type === 'workspace_oauth' || id.type === 'remote_server_token') && id.workspaceId) {
    parts.push(id.workspaceId);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Source-scoped format:
  // Source credentials: source_oauth::{workspaceId}::{sourceId}
  if (isSourceCredential(id.type) && id.workspaceId && id.sourceId) {
    parts.push(id.workspaceId);
    parts.push(id.sourceId);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Plugin MCP server-scoped format (global):
  // plugin_mcp_oauth::{pluginKey}::{serverName}
  if (isPluginMcpCredential(id.type) && id.pluginKey && id.serverName) {
    parts.push(id.pluginKey);
    parts.push(id.serverName);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // UB6.1 — decision-provider format:
  // decision_api_key::{provider}
  if (isDecisionCredential(id.type) && id.name) {
    parts.push(id.name);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  parts.push('global');
  return parts.join(CREDENTIAL_DELIMITER);
}

// ============================================================
// Revisioned credential foundation (W7 Step 9; consumed by W8)
// ============================================================

/**
 * A stored credential with a monotonic, NON-SECRET revision. The revision
 * advances on every write/rotation/delete so a runtime can detect that its bound
 * secret changed without ever comparing secret bytes.
 */
export interface RevisionedStoredCredential extends StoredCredential {
  /** Monotonic per-credential revision. Never derived from the secret value. */
  revision: number;
}

/**
 * A runtime's binding to a specific credential revision. Carries only the
 * credential ID and the revision it was resolved against — never the secret — so
 * it is safe to embed in generation hashes, DTOs and logs.
 */
export interface RuntimeCredentialBinding {
  id: CredentialId;
  expectedRevision: number;
}

/**
 * The result of resolving a `RuntimeCredentialBinding`. The secret `value`/full
 * `credential` are present ONLY when `ready` (the credential exists and the
 * current revision still matches the binding's expected revision).
 */
export interface ResolvedRuntimeCredential {
  ready: boolean;
  /** Current non-secret revision (0 when absent). */
  revision: number;
  /** Present only when `ready`. */
  value?: string;
  /** Present only when `ready`. */
  credential?: StoredCredential;
}

// ============================================================
// Credential Health Check Types
// ============================================================

/** Types of credential health issues detected at startup */
export type CredentialHealthIssueType =
  | 'file_corrupted'         // Credential file exists but can't be parsed
  | 'decryption_failed'      // File exists but can't be decrypted (machine migration)
  | 'no_default_credentials' // No credentials for the default connection

/** A single credential health issue */
export interface CredentialHealthIssue {
  type: CredentialHealthIssueType
  /** Human-readable error message */
  message: string
  /** Original error if available */
  error?: string
}

/** Result of credential store health check */
export interface CredentialHealthStatus {
  /** True if credential store is healthy and usable */
  healthy: boolean
  /** List of issues found (empty if healthy) */
  issues: CredentialHealthIssue[]
}

/** Parse credential store account string back to CredentialId. Returns null if invalid. */
export function accountToCredentialId(account: string): CredentialId | null {
  const parts = account.split(CREDENTIAL_DELIMITER);
  const typeStr = parts[0];

  // Validate the type
  if (!typeStr || !isValidCredentialType(typeStr)) {
    return null;
  }

  const type = typeStr;

  // LLM connection-scoped format:
  // llm_api_key::{connectionSlug}
  // llm_oauth::{connectionSlug}
  if (isLlmCredential(type) && parts.length === 2) {
    return { type, connectionSlug: parts[1] };
  }

  // Workspace-scoped format (no source):
  // workspace_oauth::{workspaceId}
  if ((type === 'workspace_oauth' || type === 'remote_server_token') && parts.length === 2) {
    return { type, workspaceId: parts[1] };
  }

  // Source-scoped format:
  // Source credentials: source_oauth::{workspaceId}::{sourceId}
  if (isSourceCredential(type) && parts.length === 3) {
    return { type, workspaceId: parts[1], sourceId: parts[2] };
  }

  // Plugin MCP server-scoped format (global):
  // plugin_mcp_oauth::{pluginKey}::{serverName}
  if (isPluginMcpCredential(type) && parts.length === 3) {
    return { type, pluginKey: parts[1], serverName: parts[2] };
  }

  // UB6.1 — decision-provider format:
  // decision_api_key::{provider}
  if (isDecisionCredential(type) && parts.length === 2 && parts[1] && parts[1] !== 'global') {
    return { type, name: parts[1] };
  }

  if (parts.length === 2 && parts[1] === 'global') {
    return { type };
  }

  // Unknown format
  return null;
}

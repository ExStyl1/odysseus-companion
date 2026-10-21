/**
 * Session Tools Core - Types
 *
 * Shared type definitions for session-scoped tools used by both
 * Claude (in-process) and Codex (subprocess) implementations.
 */

// ============================================================
// Credential Input Modes
// ============================================================

/**
 * Credential input modes for different authentication types
 */
export type CredentialInputMode = 'bearer' | 'basic' | 'header' | 'query' | 'multi-header';

// ============================================================
// Service Types (simplified for portability)
// ============================================================

/**
 * Google service types for OAuth
 */
export type GoogleService = 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets' | 'youtube' | 'searchconsole';

// ============================================================
// Auth Request Types
// ============================================================

/**
 * Auth request type discriminator
 */
export type AuthRequestType =
  | 'credential'
  | 'oauth'
  | 'oauth-google'
  | 'dp';

/**
 * Base auth request fields shared by all auth types
 */
export interface BaseAuthRequest {
  requestId: string;
  sessionId: string;
  sourceSlug: string;
  sourceName: string;
}

/**
 * Credential auth request - prompts for API key, bearer token, etc.
 */
export interface CredentialAuthRequest extends BaseAuthRequest {
  type: 'credential';
  mode: CredentialInputMode;
  labels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  description?: string;
  hint?: string;
  headerName?: string;
  /** Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"]) */
  headerNames?: string[];
  /** Source URL/domain for password manager credential matching (1Password, etc.) */
  sourceUrl?: string;
  /** For basic auth: whether password is required. Default true for backward compatibility. */
  passwordRequired?: boolean;
}

/**
 * MCP OAuth auth request - standard OAuth 2.0 + PKCE
 */
export interface McpOAuthAuthRequest extends BaseAuthRequest {
  type: 'oauth';
  /**
   * Capability-path target (C2): when present, the OAuth flow authenticates a
   * plugin-owned MCP server's GLOBAL credential slot instead of a source.
   * `sourceSlug`/`sourceName` then carry display identity only — completion
   * routes by this target, never by a source lookup.
   */
  pluginServer?: {
    pluginKey: string;
    serverName: string;
  };
}

/**
 * Google OAuth auth request - Google-specific OAuth
 */
export interface GoogleOAuthAuthRequest extends BaseAuthRequest {
  type: 'oauth-google';
  service?: GoogleService;
}

export interface DpAuthRequest extends BaseAuthRequest {
  type: 'dp';
  provider: 'dp';
}

/**
 * Union of all auth request types
 */
export type AuthRequest =
  | CredentialAuthRequest
  | McpOAuthAuthRequest
  | GoogleOAuthAuthRequest
  | DpAuthRequest;

/**
 * Auth result - sent back to agent after auth completes
 */
export interface AuthResult {
  requestId: string;
  sourceSlug: string;
  success: boolean;
  cancelled?: boolean;
  error?: string;
  // Additional info for successful auth
  email?: string;      // For OAuth providers that return an account email
  workspace?: string;
}

// ============================================================
// Developer Feedback
// ============================================================

/**
 * Freeform feedback from the agent to the development team.
 * Persisted as individual JSON files for later review/batch-send.
 */
export interface DeveloperFeedback {
  id: string;
  timestamp: string;
  sessionId: string;
  message: string;
}

// ============================================================
// Callback Message (IPC)
// ============================================================

/**
 * Callback message for IPC with main process.
 * Used by Codex subprocess to communicate via stderr.
 */
export interface CallbackMessage {
  __callback__: string;
  [key: string]: unknown;
}

// ============================================================
// Tool Result Types
// ============================================================

/**
 * Text content block for tool responses
 */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Image content block — MCP's own `ImageContent` shape (P6.345).
 *
 * `data` is base64, `mimeType` the image's media type, exactly as
 * `agent-sdk/custom-tools.md#return-images-and-resources` describes for a
 * custom tool's return value. All three runtimes accept it already: claude
 * through the SDK's `tool()` (whose handler returns MCP's `CallToolResult`),
 * codex through `McpToolCallResult`, Pi through its MCP client. The constraint
 * was ours alone.
 */
export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/**
 * Embedded-resource content block — MCP's own `EmbeddedResource` shape.
 *
 * One of `text` or `blob` carries the body; `uri` names it.
 */
export interface ResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

/** The non-text blocks a registry tool may return alongside its text. */
export type NonTextContent = ImageContent | ResourceContent;

/**
 * Standard tool result type compatible with both SDK and MCP patterns
 */
export interface ToolResult {
  content: TextContent[];
  /**
   * Non-text blocks, appended AFTER `content` by every adapter (P6.345).
   *
   * **Why this is a second field and not a widened `content`.** MCP's own shape
   * is a union inside `content`, and that is the shape this would ideally take.
   * `TextContent[]` has ~300 references across packages several other lanes
   * hold, and widening the required array retypes every one of them — a
   * repo-wide retype is not a parity repair, and the file-zoning rule makes it
   * impossible to land honestly from here. So the channel is ADDITIVE: a
   * registry tool can now return an image or a named resource without
   * declaring its own result type outside the registry, which is what the row
   * asked for, and the ideal merge stays available as a later refactor with
   * nothing to undo.
   *
   * Adapters that must honour it: `session-scoped-tools.ts:convertResult`
   * (claude) and `session-mcp-server/src/index.ts` (codex and Pi, over MCP).
   */
  extraContent?: NonTextContent[];
  /**
   * Optional structured payload for MCP clients.
   *
   * Set it only when there is a RECORD to carry, and never as an empty
   * placeholder: a codex client hands the model the serialized payload
   * INSTEAD of `content` whenever the field is present and non-null, so an
   * empty one silently replaces the reply text with `{}` (the upstream rule is
   * quoted in `response.ts`, the live measurement in T6's narrative). Absent is
   * the neutral value; `{}` is not.
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ============================================================
// Validation Result Types
// ============================================================

/**
 * Individual validation issue
 */
export interface ValidationIssue {
  path: string;
  message: string;
  suggestion?: string;
}

/**
 * Result of validation operations
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// ============================================================
// Source Config Types (simplified for core package)
// ============================================================

/**
 * Source type discriminator
 */
export type SourceType = 'mcp' | 'api' | 'local';

/**
 * MCP transport type
 */
export type McpTransport = 'http' | 'sse' | 'stdio';

/**
 * MCP auth type
 */
export type McpAuthType = 'oauth' | 'bearer' | 'none';

/**
 * API auth type
 */
export type ApiAuthType = 'bearer' | 'header' | 'query' | 'basic' | 'oauth' | 'none';

/**
 * MCP source configuration block
 */
export interface McpSourceConfig {
  transport?: McpTransport;
  url?: string;
  authType?: McpAuthType;
  clientId?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Header names for credential-store auth (e.g., ["X-API-Key"]) */
  headerNames?: string[];
}

/**
 * API source configuration block
 */
export interface ApiSourceConfig {
  baseUrl: string;
  authType: ApiAuthType;
  headerName?: string;
  /** Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"]) */
  headerNames?: string[];
  queryParam?: string;
  authScheme?: string;
  /** Headers sent with every request, merged before auth headers */
  defaultHeaders?: Record<string, string>;
  testEndpoint?: {
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  // Google OAuth
  googleService?: GoogleService;
  googleScopes?: string[];
  googleOAuthClientId?: string;
  googleOAuthClientSecret?: string;
  // Generic OAuth config (when authType is 'oauth' and provider is not google)
  oauth?: {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    audience?: string;
    extraParams?: Record<string, string>;
  };
}

/**
 * Local source configuration block
 */
export interface LocalSourceConfig {
  path: string;
  format?: string;
}

/**
 * Connection status for sources
 */
export type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'unknown';

/**
 * Full source configuration (simplified version for core package)
 */
export interface SourceConfig {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  provider: string;
  type: SourceType;
  mcp?: McpSourceConfig;
  api?: ApiSourceConfig;
  local?: LocalSourceConfig;
  isAuthenticated?: boolean;
  lastTestedAt?: number; // millisecond timestamp
  createdAt?: number;
  updatedAt?: number;
  // Display fields
  tagline?: string;
  icon?: string; // URL, emoji, or omitted for local file
  // Connection tracking
  connectionStatus?: ConnectionStatus;
  connectionError?: string;
}

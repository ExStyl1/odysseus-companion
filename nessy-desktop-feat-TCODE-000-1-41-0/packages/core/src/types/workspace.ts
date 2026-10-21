/**
 * Workspace and authentication types
 */

/**
 * How MCP server should be authenticated (workspace-level)
 * Note: Different from SourceMcpAuthType which uses 'oauth' | 'bearer' | 'none' for individual sources
 */
export type McpAuthType = 'workspace_oauth' | 'workspace_bearer' | 'public';

/** Safe remote binding metadata for client-facing Workspace DTOs. */
export interface RemoteServerInfo {
  url: string;              // ws://host:port or wss://host:port
  remoteWorkspaceId: string; // ID of the workspace on the remote server
}

/** Safe workspace defaults for client-facing lifecycle DTOs. */
export interface WorkspaceDefaultsInfo {
  model?: string;
  defaultLlmConnection?: string;
  enabledSourceSlugs?: string[];
  permissionMode?: string;
  cyclablePermissionModes?: string[];
  thinkingLevel?: string;
  colorTheme?: string;
  defaultProject?: {
    handleId: string;
    name?: string;
    trusted: boolean;
  };
}

/**
 * Client-facing workspace DTO — safe to send over RPC to remote clients.
 * Does not expose server-internal filesystem paths.
 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  lastAccessedAt?: number;
  iconUrl?: string;
  mcpUrl?: string;
  mcpAuthType?: McpAuthType;
  remoteServer?: RemoteServerInfo;
  defaults?: WorkspaceDefaultsInfo;
  hasCredential?: boolean;
}

/** @deprecated Use WorkspaceInfo for transport and ResolvedWorkspace server-side. */
export type Workspace = WorkspaceInfo;

/**
 * Authentication type for AI provider
 * - api_key: Anthropic API key
 * - oauth_token: Claude Max OAuth (Anthropic)
 * - codex_oauth: ChatGPT Plus OAuth via Codex app-server
 * - codex_api_key: OpenAI API key via Codex (OpenRouter, Vercel AI Gateway compatible)
 */
export type AuthType = 'api_key' | 'oauth_token' | 'codex_oauth' | 'codex_api_key';

/**
 * OAuth credentials from a fresh authentication flow.
 * Used for temporary state in UI components before saving to credential store.
 */
export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  tokenType: string;
}

// Config stored in JSON file (credentials stored in encrypted file, not here)
export interface StoredConfig {
  authType?: AuthType;
  workspaceRefs: Array<{ id: string; lastAccessedAt: number }>;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;  // Currently active session (primary scope)
  model?: string;
}

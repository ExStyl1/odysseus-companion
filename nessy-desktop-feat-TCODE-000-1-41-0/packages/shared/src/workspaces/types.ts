/**
 * Workspace Types
 *
 * Workspaces are the top-level organizational unit. Everything (sources, sessions)
 * is scoped to a workspace.
 *
 * Directory structure:
 * CONFIG_DIR/workspaces/{workspaceId}/
 *   ├── config.json      - Workspace settings
 *   ├── sources/         - Data sources (MCP, API, local)
 *   └── sessions/        - Conversation sessions
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { ProjectKey } from '../projects/project-identity.ts';

/** Server-only validated external default project. Never copy into public Workspace DTOs. */
export interface WorkspaceDefaultProject {
  workingDirectory: string;
  /** Stable identities only. Process-only keys must not be persisted. */
  projectKey?: ProjectKey;
}

/**
 * Local MCP server configuration
 * Controls whether stdio-based (local subprocess) MCP servers can be spawned.
 */
export interface LocalMcpConfig {
  /**
   * Whether local (stdio) MCP servers are enabled for this workspace.
   * When false, only HTTP-based MCP servers will be used.
   * Default: true (can be overridden by NESSY_LOCAL_MCP_ENABLED env var)
   */
  enabled: boolean;
}

/** Non-secret remote binding persisted in the local Workspace config. */
export interface RemoteWorkspaceBinding {
  url: string;
  remoteWorkspaceId: string;
}

/**
 * Workspace configuration (stored in config.json)
 */
export interface WorkspaceConfig {
  id: string;
  name: string;

  /**
   * Default settings for new sessions in this workspace
   */
  defaults?: {
    model?: string;
    /** Default LLM connection for new sessions (slug). Overrides global default. */
    defaultLlmConnection?: string;
    enabledSourceSlugs?: string[]; // Sources to enable by default
    permissionMode?: PermissionMode; // Default permission mode ('dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'; a stored 'explore' reads as 'plan')
    cyclablePermissionModes?: PermissionMode[]; // Which modes can be cycled with SHIFT+TAB (min 2; default: DEFAULT_CYCLABLE_PERMISSION_MODES — every mode but dontAsk, bypassPermissions included since D1.369)
    thinkingLevel?: ThinkingLevel; // Default thinking level for new sessions (default: 'medium')
    colorTheme?: string; // Color theme override for this workspace (preset ID). Undefined = inherit from app default.
    defaultProject?: WorkspaceDefaultProject;
  };

  /**
   * Local MCP server configuration.
   * Controls whether stdio-based MCP servers can be spawned in this workspace.
   * Resolution order: ENV (NESSY_LOCAL_MCP_ENABLED) > workspace config > default (true)
   */
  localMcpServers?: LocalMcpConfig;

  /** Remote binding metadata is owned by the Workspace folder config. */
  remoteServer?: RemoteWorkspaceBinding;

  createdAt: number;
  updatedAt: number;
}

/**
 * Workspace creation input
 */
export interface CreateWorkspaceInput {
  name: string;
  defaults?: WorkspaceConfig['defaults'];
}

export type WorkspaceCreationDefaults = Omit<NonNullable<WorkspaceConfig['defaults']>, 'defaultProject'>;

export type WorkspaceDefaultSettingKey = Exclude<keyof NonNullable<WorkspaceConfig['defaults']>, 'defaultProject'>;

/** ID-scoped Workspace settings mutation. Raw roots are never accepted. */
export interface UpdateWorkspaceSettingsInput {
  defaults?: Partial<Omit<NonNullable<WorkspaceConfig['defaults']>, 'defaultProject'>>;
  clearDefaults?: WorkspaceDefaultSettingKey[];
  localMcpEnabled?: boolean;
}

export interface CreateWorkspaceRequest {
  name: string;
  defaults?: WorkspaceCreationDefaults;
}

export interface ConnectRemoteWorkspaceInput {
  name: string;
  url: string;
  token: string;
  remoteWorkspaceId: string;
}

export interface UpdateRemoteWorkspaceInput {
  workspaceId: string;
  url: string;
  remoteWorkspaceId: string;
  token?: string;
}

export interface CreateWorkspaceOnRemoteInput {
  url: string;
  token: string;
  name: string;
}

/** Trusted server/main transport input. Never serialize through renderer RPC. */
export interface ResolvedRemoteWorkspaceConnection {
  localWorkspaceId: string;
  url: string;
  remoteWorkspaceId: string;
  token: string;
}

/** The only Workspace-owned data held in the global registry. */
export interface StoredWorkspaceRef {
  id: string;
  lastAccessedAt: number;
}

/** Server-only binding resolved from a global ref and folder config. */
export interface ResolvedWorkspace {
  id: string;
  workspaceRootPath: string;
  sessionRootPath: string;
  config: WorkspaceConfig;
  lastAccessedAt: number;
}

export interface WorkspaceDeleteResult {
  deleted: boolean;
  cleanupFailures: Array<{
    resource:
      | 'workspace-data' | 'session-data' | 'credentials' | 'runtime'
      | 'plugin-data' | 'capability-policy' | 'capability-trust' | 'recent-projects';
    code: string;
    message: string;
  }>;
}

export interface WorkspaceCleanupParticipant {
  id: string;
  /** Transaction operations are idempotent; rollback compensates staged or partial committed state. */
  stage(workspaceId: string, transactionId: string): Promise<void>;
  commit(transactionId: string): Promise<void>;
  rollback(transactionId: string): Promise<void>;
}

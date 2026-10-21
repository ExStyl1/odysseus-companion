/**
 * Workspace Module
 *
 * Re-exports types and storage functions for workspaces.
 */

// Types
export type {
  WorkspaceConfig,
  WorkspaceDefaultProject,
  CreateWorkspaceInput,
  WorkspaceCreationDefaults,
  WorkspaceDefaultSettingKey,
  UpdateWorkspaceSettingsInput,
  CreateWorkspaceRequest,
  ConnectRemoteWorkspaceInput,
  UpdateRemoteWorkspaceInput,
  CreateWorkspaceOnRemoteInput,
  RemoteWorkspaceBinding,
  ResolvedRemoteWorkspaceConnection,
  StoredWorkspaceRef,
  ResolvedWorkspace,
  WorkspaceDeleteResult,
  WorkspaceCleanupParticipant,
} from './types.ts';

// Storage functions
export {
  // Path utilities
  getWorkspaceSourcesPath,
  getWorkspaceSessionsPath,
  getWorkspaceSkillsPath,
  // Read-only config access for server runtime consumers
  loadWorkspaceConfig,
  // Pure config transformation
  setWorkspaceDefaultProject,
  // Constants
  CONFIG_DIR,
  DEFAULT_WORKSPACES_DIR,
} from './storage.ts';

export {
  WORKSPACES_DIR,
  SESSIONS_DIR,
  PLUGINS_DIR,
  PLUGIN_CACHE_DIR,
  PLUGIN_DATA_DIR,
  GLOBAL_CAPABILITY_POLICY_PATH,
  PROJECT_TRUST_PATH,
  CAPABILITY_TRUST_PATH,
  RECENT_PROJECTS_PATH,
  assertStorageId,
  resolveContainedPath,
  isPathWithin,
  getWorkspaceRootPath,
  getWorkspaceSessionRootPath,
  getSessionStoragePath,
  getPluginCachePath,
  encodePluginStorageKey,
  getPluginDataRoot,
  pluginKeyFor,
} from './paths.ts';

export {
  STORAGE_LAYOUT_VERSION,
  DEFAULT_CONFIG_DIR,
  IS_DEFAULT_CONFIG_DIR,
  ensureStorageLayoutV2,
} from './storage-readiness.ts';

export type {
  StorageHostLease,
  StorageReadinessBlockedCode,
  StorageReadinessResult,
  VerifiedStorageLayoutV2,
} from './storage-readiness.ts';

export {
  CanonicalWorkspaceService,
  RemoteWorkspaceConnectionError,
  RemoteWorkspaceLocalCommitError,
  defaultWorkspaceCleanupParticipants,
  createWorkspaceService,
  normalizeWorkspaceName,
  workspaceNameKey,
} from './service.ts';

export type {
  WorkspaceService,
  WorkspaceQuiescence,
  WorkspaceQuiescenceLease,
  WorkspaceCredentialManager,
  WorkspaceDefaultProjectResolver,
  RemoteWorkspaceGateway,
  WorkspaceServiceOptions,
} from './service.ts';

/**
 * Workspace Storage
 *
 * Managed Workspace folder operations.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { CONFIG_DIR, WORKSPACES_DIR, getWorkspaceRootPath } from './paths.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { parsePermissionMode } from '../agent/mode-types.ts';
import { getDefaultStatusConfig, saveStatusConfig, ensureDefaultIconFiles } from '../statuses/storage.ts';
import { getDefaultLabelConfig, saveLabelConfig } from '../labels/storage.ts';
import type {
  WorkspaceConfig,
  WorkspaceDefaultProject,
} from './types.ts';

const DEFAULT_WORKSPACES_DIR = WORKSPACES_DIR;

// ============================================================
// Path Utilities
// ============================================================

/**
 * Get the default workspaces directory.
 */
export function getDefaultWorkspacesDir(): string {
  return DEFAULT_WORKSPACES_DIR;
}

/**
 * Ensure default workspaces directory exists
 */
export function ensureDefaultWorkspacesDir(): void {
  if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
    mkdirSync(DEFAULT_WORKSPACES_DIR, { recursive: true });
  }
}

/**
 * Get workspace root path from ID
 * @param workspaceId - Workspace ID
 * @returns Absolute path to workspace root in default location
 */
export function getWorkspacePath(workspaceId: string): string {
  return getWorkspaceRootPath(workspaceId);
}

/**
 * Get path to workspace sources directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSourcesPath(rootPath: string): string {
  return join(rootPath, 'sources');
}

/**
 * Get path to workspace sessions directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSessionsPath(rootPath: string): string {
  return join(rootPath, 'sessions');
}

/**
 * Get path to workspace skills directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSkillsPath(rootPath: string): string {
  return join(rootPath, 'skills');
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load workspace config.json from a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function loadWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  const configPath = join(rootPath, 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    const config = readJsonFileSync<WorkspaceConfig>(configPath);
    normalizeWorkspaceConfigPermissionModes(config);
    return config;
  } catch {
    return null;
  }
}

/**
 * Alias-resolve the persisted workspace-default mode spellings in place. A
 * workspace written before the vocabulary flip carries `safe`/`ask`/
 * `allow-all`; downstream consumers compare against the current internal
 * keys, so an unresolved legacy spelling would silently fall out of every
 * mode gate. Unresolvable strings are left as-is (same defensive posture as
 * the session loader's nested fields).
 */
function normalizeWorkspaceConfigPermissionModes(config: WorkspaceConfig): void {
  const defaults = config?.defaults;
  if (!defaults || typeof defaults !== 'object') return;
  if (typeof defaults.permissionMode === 'string') {
    const parsed = parsePermissionMode(defaults.permissionMode);
    if (parsed) defaults.permissionMode = parsed;
  }
  if (Array.isArray(defaults.cyclablePermissionModes)) {
    defaults.cyclablePermissionModes = [...new Set(defaults.cyclablePermissionModes.map(mode => // deduped: F1.1050 reads explore as plan, and a stored [explore, plan] must not cycle plan twice
      typeof mode === 'string' ? parsePermissionMode(mode) ?? mode : mode,
    ))] as typeof defaults.cyclablePermissionModes;
  }
}

/**
 * Save workspace config.json to a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function saveWorkspaceConfig(rootPath: string, config: WorkspaceConfig): void {
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw new Error('Managed Workspace root is missing');
  }

  // Convert paths to portable form for cross-machine compatibility
  const storageConfig: WorkspaceConfig = {
    ...config,
    updatedAt: Date.now(),
  };

  // Use atomic write to prevent corruption on crash/interrupt
  atomicWriteFileSync(join(rootPath, 'config.json'), JSON.stringify(storageConfig, null, 2));
}

/** Set the durable backend-owned default-project identity after Workspace creation. */
export function setWorkspaceDefaultProject(config: WorkspaceConfig, project: WorkspaceDefaultProject): WorkspaceConfig {
  return {
    ...config,
    defaults: {
      ...config.defaults,
      defaultProject: { ...project },
    },
  };
}

/** Initialize Workspace-owned files for a precomputed immutable ID. */
export function initializeWorkspaceAtRoot(rootPath: string, config: WorkspaceConfig): void {
  mkdirSync(rootPath, { recursive: true });
  mkdirSync(getWorkspaceSourcesPath(rootPath), { recursive: true });
  mkdirSync(getWorkspaceSessionsPath(rootPath), { recursive: true });
  mkdirSync(getWorkspaceSkillsPath(rootPath), { recursive: true });

  saveWorkspaceConfig(rootPath, config);
  saveStatusConfig(rootPath, getDefaultStatusConfig());
  ensureDefaultIconFiles(rootPath);
  saveLabelConfig(rootPath, getDefaultLabelConfig());
  ensurePluginManifest(rootPath, config.name);
}

/**
 * Check if a valid workspace exists at a path
 * @param rootPath - Absolute path to check
 */
export function isValidWorkspace(rootPath: string): boolean {
  return existsSync(join(rootPath, 'config.json'));
}

/**
 * Rename a workspace (updates config.json in the workspace folder)
 * @param rootPath - Absolute path to workspace root folder
 * @param newName - New display name
 */
export function renameWorkspaceFolder(rootPath: string, newName: string): boolean {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return false;

  config.name = newName.trim();
  saveWorkspaceConfig(rootPath, config);
  return true;
}

// ============================================================
// Workspace Color Theme
// ============================================================

/**
 * Get the color theme setting for a workspace.
 * Returns undefined if workspace uses the app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @returns Theme ID or undefined (inherit from app default)
 */
export function getWorkspaceColorTheme(rootPath: string): string | undefined {
  const config = loadWorkspaceConfig(rootPath);
  return config?.defaults?.colorTheme;
}

/**
 * Set the color theme for a workspace.
 * Pass undefined to clear and use app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @param themeId - Preset theme ID or undefined to inherit
 */
export function setWorkspaceColorTheme(rootPath: string, themeId: string | undefined): void {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return;

  // Validate theme ID if provided (skip for undefined = inherit default)
  // Only allow alphanumeric characters, hyphens, and underscores (max 64 chars)
  if (themeId && themeId !== 'default') {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(themeId)) {
      console.warn(`[workspace-storage] Invalid theme ID rejected: ${themeId}`);
      return;
    }
  }

  // Initialize defaults if not present
  if (!config.defaults) {
    config.defaults = {};
  }

  if (themeId) {
    config.defaults.colorTheme = themeId;
  } else {
    delete config.defaults.colorTheme;
  }

  saveWorkspaceConfig(rootPath, config);
}

// ============================================================
// Local MCP Configuration
// ============================================================

/**
 * Check if local (stdio) MCP servers are enabled for a workspace.
 * Resolution order: ENV (NESSY_LOCAL_MCP_ENABLED) > workspace config > default (true)
 *
 * @param rootPath - Absolute path to workspace root folder
 * @returns true if local MCP servers should be enabled
 */
export function isLocalMcpEnabled(rootPath: string): boolean {
  // 1. Environment variable override (highest priority)
  const envValue = process.env.NESSY_LOCAL_MCP_ENABLED;
  if (envValue !== undefined) {
    return envValue.toLowerCase() === 'true';
  }

  // 2. Workspace config
  const config = loadWorkspaceConfig(rootPath);
  if (config?.localMcpServers?.enabled !== undefined) {
    return config.localMcpServers.enabled;
  }

  // 3. Default: enabled
  return true;
}

// ============================================================
// Exports
// ============================================================

// ============================================================
// Plugin Manifest (for SDK plugin integration)
// ============================================================

/**
 * Ensure workspace has a .claude-plugin/plugin.json manifest.
 * This allows the workspace to be loaded as an SDK plugin,
 * enabling skills, commands, and agents from the workspace.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @param workspaceName - Display name for the workspace (used in plugin name)
 */
export function ensurePluginManifest(rootPath: string, workspaceName: string): void {
  const pluginDir = join(rootPath, '.claude-plugin');
  const manifestPath = join(pluginDir, 'plugin.json');

  if (existsSync(manifestPath)) return;

  // Create .claude-plugin directory
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }

  // Create minimal plugin manifest
  const manifest = {
    name: `nessy-workspace-${workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    version: '1.0.0',
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

export { CONFIG_DIR, DEFAULT_WORKSPACES_DIR };

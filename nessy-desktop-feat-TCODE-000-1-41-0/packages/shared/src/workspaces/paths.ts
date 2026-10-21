import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONFIG_DIR } from '../config/paths.ts';
import type { PluginCacheRef, PluginKey } from '../plugins/types.ts';

export { CONFIG_DIR, DEFAULT_CONFIG_DIR, IS_DEFAULT_CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '../config/paths.ts';

export const WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');
export const SESSIONS_DIR = join(CONFIG_DIR, 'sessions');
export const PLUGINS_DIR = join(CONFIG_DIR, 'plugins');
export const PLUGIN_CACHE_DIR = join(PLUGINS_DIR, 'cache');
export const PLUGIN_DATA_DIR = join(PLUGINS_DIR, 'data');
export const GLOBAL_CAPABILITY_POLICY_PATH = join(CONFIG_DIR, 'capabilities.json');
export const PROJECT_TRUST_PATH = join(CONFIG_DIR, 'project-trust.json');
export const CAPABILITY_TRUST_PATH = join(CONFIG_DIR, 'capability-trust.json');
export const RECENT_PROJECTS_PATH = join(CONFIG_DIR, 'recent-projects.json');

const STORAGE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/;

export function assertStorageId(kind: 'workspace' | 'session', value: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value === '.'
    || value === '..'
    || isAbsolute(value)
    || !STORAGE_ID_PATTERN.test(value)
  ) {
    throw new Error(`Invalid ${kind} storage ID`);
  }
  return value;
}

export function resolveContainedPath(root: string, ...parts: string[]): string {
  const target = resolve(root, ...parts);
  assertContained(root, target);
  return target;
}

export function isPathWithin(root: string, path: string): boolean {
  try {
    assertContained(root, path);
    return true;
  } catch {
    return false;
  }
}

export function getWorkspaceRootPath(workspaceId: string): string {
  return resolveContainedPath(WORKSPACES_DIR, assertStorageId('workspace', workspaceId));
}

export function getWorkspaceSessionRootPath(workspaceId: string): string {
  return resolveContainedPath(SESSIONS_DIR, assertStorageId('workspace', workspaceId));
}

export function getSessionStoragePath(workspaceId: string, sessionId: string): string {
  return resolveContainedPath(
    getWorkspaceSessionRootPath(workspaceId),
    assertStorageId('session', sessionId),
  );
}

function encodeSegment(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error('Plugin key segments must be non-empty strings without NUL bytes');
  }
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Build the stable, version-LESS plugin key from its identity components. The
 * two base64url segments are joined by `.` (never produced by base64url), so the
 * mapping is unambiguous and collision-free across marketplace/plugin pairs.
 */
export function pluginKeyFor(marketplaceId: string, pluginId: string): PluginKey {
  return `${encodeSegment(marketplaceId)}.${encodeSegment(pluginId)}`;
}

/**
 * Collision-free single path segment for a stable `PluginKey` (used for the
 * writable-data directory). Distinct from the cache path, which is version- and
 * bundle-hash-addressed.
 */
export function encodePluginStorageKey(pluginKey: PluginKey): string {
  if (typeof pluginKey !== 'string' || !pluginKey || pluginKey.includes('\0') || pluginKey.includes('/')) {
    throw new Error('Plugin key must be a non-empty path-free string');
  }
  return Buffer.from(pluginKey, 'utf8').toString('base64url');
}

/**
 * Physical, content-addressed cache directory for a plugin bundle:
 * `<cacheDir>/<enc(marketplaceId)>/<enc(pluginId)>/<enc(version)>/<bundleHash>`.
 * `cacheDir` defaults to the managed cache root; the store passes its own root so
 * every cache path still routes through this single W1 helper.
 */
export function getPluginCachePath(ref: PluginCacheRef, cacheDir: string = PLUGIN_CACHE_DIR): string {
  if (!BUNDLE_HASH_PATTERN.test(ref.bundleHash)) {
    throw new Error('Plugin bundle hash must be 64 lowercase hexadecimal characters');
  }
  return resolveContainedPath(
    cacheDir,
    encodeSegment(ref.marketplaceId),
    encodeSegment(ref.pluginId),
    encodeSegment(ref.version),
    ref.bundleHash,
  );
}

/**
 * Version-less writable-data root for a plugin. Because the key excludes the
 * version, a plugin's data survives version updates (W7 Step 7).
 */
export function getPluginDataRoot(pluginKey: PluginKey, dataDir: string = PLUGIN_DATA_DIR): string {
  return resolveContainedPath(dataDir, encodePluginStorageKey(pluginKey));
}

function assertContained(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (!isLexicallyContained(resolvedRoot, resolvedPath)) {
    throw new Error('Path escapes managed storage root');
  }

  const realRoot = realPathOrNull(resolvedRoot);
  const realPath = realExistingAncestor(resolvedPath);
  if (realRoot && realPath && !isLexicallyContained(realRoot, realPath)) {
    throw new Error('Path escapes managed storage root through a symlink');
  }
}

function isLexicallyContained(root: string, path: string): boolean {
  const pathRelative = relative(root, path);
  return pathRelative === '' || (
    !isAbsolute(pathRelative)
    && pathRelative !== '..'
    && !pathRelative.startsWith(`..${sep}`)
  );
}

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function realExistingAncestor(path: string): string | null {
  let current = path;
  while (true) {
    const realPath = realPathOrNull(current);
    if (realPath) return realPath;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

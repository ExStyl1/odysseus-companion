/**
 * Removal-only support for legacy plaintext source credential caches.
 *
 * Current runtimes read `credentials.enc` directly and must never create a
 * decrypted cache. These helpers exist solely to delete files left by older
 * versions. The active runtime has no plaintext-cache path.
 */
import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { LoadedSource } from './types.ts';

export const SOURCE_CREDENTIAL_CACHE_FILENAME = '.credential-cache.json';

export type LegacySourceCredentialCacheLocation = Pick<
  LoadedSource,
  'folderPath' | 'workspaceRootPath'
>;

const UNSAFE_PATH_ERROR = 'source-credential-cache-path-unsafe';

function unsafePath(cause?: unknown): Error {
  return new Error(UNSAFE_PATH_ERROR, cause === undefined ? undefined : { cause });
}

/** Resolve only a real, direct child of the managed workspace `sources/` dir. */
export function legacySourceCredentialCachePath(
  source: LegacySourceCredentialCacheLocation,
): string {
  try {
    if (!isAbsolute(source.workspaceRootPath) || !isAbsolute(source.folderPath)) throw unsafePath();
    const workspaceRoot = realpathSync(resolve(source.workspaceRootPath));
    const sourcesPath = join(workspaceRoot, 'sources');
    const sourcesStat = lstatSync(sourcesPath);
    if (sourcesStat.isSymbolicLink() || !sourcesStat.isDirectory()) throw unsafePath();
    const sourcesRoot = realpathSync(sourcesPath);
    const sourcePath = resolve(source.folderPath);
    const sourceStat = lstatSync(sourcePath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw unsafePath();
    const sourceFolder = realpathSync(sourcePath);
    if (dirname(sourceFolder) !== sourcesRoot) throw unsafePath();
    return join(sourceFolder, SOURCE_CREDENTIAL_CACHE_FILENAME);
  } catch (error) {
    if (error instanceof Error && error.message === UNSAFE_PATH_ERROR) throw error;
    throw unsafePath(error);
  }
}

/** Remove caches from every direct managed source directory, including malformed sources. */
export function deleteLegacySourceCredentialCaches(workspaceRootPath: string): number {
  if (!isAbsolute(workspaceRootPath)) throw unsafePath();
  const workspaceRoot = realpathSync(resolve(workspaceRootPath));
  const sourcesPath = join(workspaceRoot, 'sources');
  let sourcesStat: ReturnType<typeof lstatSync>;
  try {
    sourcesStat = lstatSync(sourcesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  if (sourcesStat.isSymbolicLink() || !sourcesStat.isDirectory()) throw unsafePath();

  let deleted = 0;
  for (const entry of readdirSync(sourcesPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw unsafePath();
    if (!entry.isDirectory()) continue;
    if (deleteLegacySourceCredentialCache({
      workspaceRootPath: workspaceRoot,
      folderPath: join(sourcesPath, entry.name),
    })) deleted += 1;
  }
  return deleted;
}

/**
 * Delete one legacy cache without following the final path if it is a symlink.
 * Directories and other unexpected node types fail closed.
 */
export function deleteLegacySourceCredentialCache(
  source: LegacySourceCredentialCacheLocation,
): boolean {
  const path = legacySourceCredentialCachePath(source);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw unsafePath();
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (error instanceof Error && error.message === UNSAFE_PATH_ERROR) throw error;
    throw error;
  }
}

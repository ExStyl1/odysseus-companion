import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

function normalizePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isWithin(base: string, target: string): boolean {
  const normalizedBase = normalizePath(base);
  const normalizedTarget = normalizePath(target);
  const rel = relative(normalizedBase, normalizedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realpathIfExists(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}

/**
 * Lexical + symlink-aware containment check for existing paths.
 */
export function isPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const resolvedBase = resolve(baseDir);

  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = realpathIfExists(resolvedBase);
  const realTarget = realpathIfExists(resolvedTarget);
  return isWithin(realBase, realTarget);
}

/**
 * Containment check for output/creation paths.
 *
 * Prevents symlink escapes by validating the nearest existing ancestor's real path.
 */
export function isPathWithinDirectoryForCreation(targetPath: string, baseDir: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const resolvedBase = resolve(baseDir);

  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = realpathIfExists(resolvedBase);

  if (existsSync(resolvedTarget)) {
    // `resolvedBase`, NOT `realBase`. `isPathWithinDirectory` runs its own
    // lexical pre-check before it realpaths anything, so handing it a base that
    // is ALREADY realpathed compares an un-realpathed target against a
    // realpathed base: whenever the base is reached through a symlink the two
    // disagree lexically and a genuinely contained file is rejected. On macOS
    // that is the common case, since `/tmp` is a symlink to `/private/tmp`.
    // The function realpaths both sides itself, so the containment guarantee is
    // unchanged — this only stops it being over-strict.
    return isPathWithinDirectory(resolvedTarget, resolvedBase);
  }

  let current = dirname(resolvedTarget);
  while (true) {
    if (existsSync(current)) {
      const realCurrent = realpathSync.native(current);
      return isWithin(realBase, realCurrent);
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

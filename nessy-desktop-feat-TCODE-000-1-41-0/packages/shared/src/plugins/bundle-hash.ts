/**
 * Canonical whole-bundle hashing (W7 Step 3).
 *
 * `computeNormalizedBundleHash()` hashes the ENTIRE normalized bundle tree —
 * every file's relative path, type, executable bit and byte content — NOT just
 * the manifest. Two bundles hash equal iff their trees are byte-for-byte and
 * mode-for-mode identical, regardless of the absolute path they live at (so a
 * bundle stays content-addressable after the config root moves). Changing a
 * skill, hook, asset or a single executable bit changes the hash, which is what
 * makes same-version repair and update side-by-side staging safe.
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Options every copy of a plugin bundle tree must use. `cp` resolves relative
 * symlinks by default, rewriting each one to an absolute path into the SOURCE
 * tree — that changes the hash this module computes (symlink targets are hashed)
 * and leaves the copy depending on a staging directory the caller is about to
 * delete. A materialized `npx` dependency graph vendors exactly such links
 * (`node_modules/.bin/*`), so verbatim copying is what keeps a legitimate bundle
 * installable. Containment is still enforced by `findUnsafeBundleSymlink`, which
 * resolves through `realpath` and so rejects an escaping link either way.
 */
export const BUNDLE_COPY_OPTIONS = {
  recursive: true,
  verbatimSymlinks: true,
} as const;

export async function findUnsafeBundleSymlink(
  path: string,
  bundleRoot: string = path,
): Promise<string | undefined> {
  const canonicalRoot = await realpath(bundleRoot);
  const visited = new Set<string>();

  const walk = async (currentPath: string): Promise<string | undefined> => {
    const stats = await lstat(currentPath);
    let directoryPath = currentPath;
    if (stats.isSymbolicLink()) {
      const resolved = await realpath(currentPath).catch(() => undefined);
      if (!resolved || !isPathInside(canonicalRoot, resolved)) return currentPath;
      if (!(await lstat(resolved)).isDirectory()) return undefined;
      directoryPath = resolved;
    } else if (!stats.isDirectory()) {
      return undefined;
    }

    if (visited.has(directoryPath)) return undefined;
    visited.add(directoryPath);
    for (const entry of await readdir(directoryPath)) {
      const unsafe = await walk(join(directoryPath, entry));
      if (unsafe) return unsafe;
    }
    return undefined;
  };

  return walk(path);
}

function isPathInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function collectEntries(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const names = await readdir(dir);
    for (const name of names.sort()) {
      const full = join(dir, name);
      out.push(relative(root, full));
      const stat = await lstat(full);
      if (stat.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  // Normalize path separators so the hash is identical across platforms.
  return out.map(entry => entry.split(sep).join('/')).sort();
}

/**
 * Compute the canonical hash of a normalized plugin bundle. Returns 64 lowercase
 * hex characters (matches the cache-path bundle-hash pattern).
 */
export async function computeNormalizedBundleHash(normalizedBundleRoot: string): Promise<string> {
  const entries = await collectEntries(normalizedBundleRoot);
  const hash = createHash('sha256');
  for (const rel of entries) {
    const full = join(normalizedBundleRoot, rel);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) {
      const target = await readlink(full);
      hash.update(`L\0${rel}\0${target.split(sep).join('/')}\n`);
      continue;
    }
    if (stat.isDirectory()) {
      hash.update(`D\0${rel}\0\n`);
      continue;
    }
    const executable = (stat.mode & 0o111) !== 0 ? '1' : '0';
    const content = await readFile(full);
    hash.update(`F\0${rel}\0${executable}\0${content.length}\0`);
    hash.update(content);
    hash.update('\n');
  }
  return hash.digest('hex');
}

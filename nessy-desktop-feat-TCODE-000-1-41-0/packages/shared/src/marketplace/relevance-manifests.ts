/**
 * The project manifests a `manifestDeps` relevance signal is matched against.
 *
 * Contract: `plugin-relevance.md` § `relevance.signals`, the `manifestDeps` row,
 * fetched 2026-09-06 — "Dependencies declared in package manifests Claude has
 * read this session. Each entry is `{ "file": "...", "pattern": "..." }`, where
 * `file` is a regular expression matched against the manifest file's path as
 * recorded in session state, typically an absolute path, and `pattern` is a
 * regular expression matched against that file's contents. ... Manifest files
 * larger than 512 KB are skipped."
 *
 * THE DIVERGENCE, stated (P6.519, owner decision Q-den 52 = B). The page's set is
 * "manifests Claude has read this session"; this fork keeps no per-session record
 * of files read, and option A of that decision — starting to keep one — was
 * refused as a privacy and retention posture the fork has never taken. So the set
 * here is instead the session PROJECT's own manifests: the immediate entries of
 * the working directory and, when it differs, of the repository root.
 *
 * WHICH FILES, and why no list of manifest names is invented. `file` is itself a
 * regular expression over the path, so the marketplace entry already says which
 * manifest it wants. This collector therefore reads only the directory entries
 * that some entry's own `file` pattern selects — a hard-coded list of manifest
 * names (`package.json`, `Cargo.toml`, and so on) would be an invention on top of
 * a page that asks for none, and it would be wrong for every ecosystem it forgot.
 *
 * Bounded by construction: two directories, non-recursive, files only, at most
 * `MANIFEST_FILES_MAX` reads, each of at most 512 KB — the byte gate applied to
 * the real `stat` size before the file is opened.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  MANIFEST_CONTENT_MAX,
  type PluginMarketplaceRelevanceV1,
  type RelevanceManifestFile,
} from './relevance.ts';

/**
 * The read budget for one collection. Ten entries of at most 512 KB is the
 * page's own ceiling on a single marketplace's demands; this bounds the whole
 * listing, which asks once for every entry in the catalog.
 */
const MANIFEST_FILES_MAX = 10;

export interface CollectRelevanceManifestsOptions {
  /** The session's working directory, absolute. */
  workingDirectory?: string;
  /** The enclosing git repository root, when the working directory is in one. */
  repositoryRoot?: string;
}

/**
 * Read the project manifests any of `relevanceBlocks`' `manifestDeps` entries
 * asks for.
 *
 * Never throws: an unreadable directory or file yields fewer manifests, which
 * yields no suggestion, which is the same answer as no match.
 */
export async function collectRelevanceManifests(
  relevanceBlocks: readonly (PluginMarketplaceRelevanceV1 | undefined)[],
  options: CollectRelevanceManifestsOptions,
): Promise<readonly RelevanceManifestFile[]> {
  const filePatterns = compileFilePatterns(relevanceBlocks);
  if (filePatterns.length === 0) return [];

  const collected: RelevanceManifestFile[] = [];
  for (const directory of candidateDirectories(options)) {
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (collected.length >= MANIFEST_FILES_MAX) return collected;
      const candidate = path.join(directory, entry);
      if (!filePatterns.some(pattern => pattern.test(candidate))) continue;
      const content = await readBoundedFile(candidate);
      if (content !== undefined) collected.push({ path: candidate, content });
    }
  }
  return collected;
}

/**
 * Every distinct `file` source across the blocks, compiled once.
 * Case-insensitive per the page; an uncompilable source is dropped rather than
 * thrown, because it arrived from a marketplace.
 */
function compileFilePatterns(
  relevanceBlocks: readonly (PluginMarketplaceRelevanceV1 | undefined)[],
): RegExp[] {
  const sources = new Set<string>();
  for (const block of relevanceBlocks) {
    for (const entry of block?.signals.manifestDeps ?? []) sources.add(entry.file);
  }
  const patterns: RegExp[] = [];
  for (const source of sources) {
    try {
      patterns.push(new RegExp(source, 'i'));
    } catch {
      // An entry whose `file` will not compile can never match; skip it.
    }
  }
  return patterns;
}

/** The working directory, plus the repository root when it is a different one. */
function candidateDirectories(options: CollectRelevanceManifestsOptions): string[] {
  const directories: string[] = [];
  if (options.workingDirectory) directories.push(options.workingDirectory);
  if (options.repositoryRoot && options.repositoryRoot !== options.workingDirectory) {
    directories.push(options.repositoryRoot);
  }
  return directories;
}

/** "Manifest files larger than 512 KB are skipped" — measured before opening. */
async function readBoundedFile(candidate: string): Promise<string | undefined> {
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isFile() || stats.size > MANIFEST_CONTENT_MAX) return undefined;
    return await fs.readFile(candidate, 'utf8');
  } catch {
    return undefined;
  }
}

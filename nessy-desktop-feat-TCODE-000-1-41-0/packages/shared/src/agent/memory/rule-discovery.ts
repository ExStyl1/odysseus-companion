/**
 * Rule-file discovery for the `.claude/rules/`-shaped instruction tier (R28).
 *
 * Contract source: `code.claude.com/docs/en/memory.md` — "All `.md` files are
 * discovered recursively, so you can organize rules into subdirectories like
 * `frontend/` or `backend/`", and "The `.claude/rules/` directory supports
 * symlinks, so you can maintain a shared set of rules and link them into
 * multiple projects. Symlinks are resolved and loaded normally, and circular
 * symlinks are detected and handled gracefully."
 *
 * This is the INVERSE of R4's deliberate symlink refusal: here a symlinked
 * directory and a symlinked file both resolve and load. Containment is not this
 * walker's job — a shared rules directory legitimately lives outside the
 * project — so the caller decides what root each discovered file is contained
 * against.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface DiscoveredRuleFile {
  /** Path as reached through the rules tree; symlinks along it are NOT collapsed. */
  path: string;
  /** Fully resolved path, symlinks collapsed. Identity for dedup. */
  realPath: string;
  /** Slash-normalized path relative to the rules directory (`frontend/react.md`). */
  relativePath: string;
}

/**
 * Bounds on one rules tree. A rules directory is hand-authored configuration,
 * not a source tree, so these are generous; they exist so a pathological link
 * farm cannot turn discovery into an unbounded walk even after cycle detection
 * has excluded the obvious loops.
 */
const RULE_FILE_LIMIT = 500;
const RULE_DEPTH_LIMIT = 16;

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

/**
 * Every `.md` file under `rulesDir`, recursively, with symlinked directories
 * and files resolved. Returns `[]` for a missing or unreadable directory.
 *
 * Cycle handling: directories are keyed by their REAL path, so a link that
 * points back into an already-visited directory is skipped instead of walked
 * again — the documented "circular symlinks are detected and handled
 * gracefully". Files are deduped by real path too, so the same shared file
 * linked in twice yields one entry.
 */
export function discoverRuleFiles(rulesDir: string): DiscoveredRuleFile[] {
  const root = resolve(rulesDir);
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
    if (!statSync(rootReal).isDirectory()) return [];
  } catch {
    return [];
  }

  const files: DiscoveredRuleFile[] = [];
  const visitedDirs = new Set<string>([rootReal]);
  const seenFiles = new Set<string>();
  const queue: Array<{ dir: string; prefix: string; depth: number }> = [
    { dir: root, prefix: '', depth: 0 },
  ];

  while (queue.length > 0) {
    const { dir, prefix, depth } = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      if (files.length >= RULE_FILE_LIMIT) return files;

      const entryPath = join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // `statSync` (not `Dirent.isFile`) is the whole point: it FOLLOWS the
      // link, so a symlinked entry is classified by its target.
      let realPath: string;
      let isDirectory: boolean;
      try {
        realPath = realpathSync(entryPath);
        isDirectory = statSync(realPath).isDirectory();
      } catch {
        continue; // broken link or unreadable entry — skip, never throw
      }

      if (isDirectory) {
        if (depth >= RULE_DEPTH_LIMIT) continue;
        if (visitedDirs.has(realPath)) continue; // cycle
        visitedDirs.add(realPath);
        queue.push({ dir: entryPath, prefix: relativePath, depth: depth + 1 });
        continue;
      }

      if (!isMarkdown(entry.name)) continue;
      if (seenFiles.has(realPath)) continue;
      seenFiles.add(realPath);
      files.push({ path: entryPath, realPath, relativePath });
    }
  }

  return files;
}

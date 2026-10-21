/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { isPathWithinRoot } from './workspaceContext.js';

export interface GitIgnoreFilter {
  isIgnored(filePath: string): boolean;
}

export class GitIgnoreParser implements GitIgnoreFilter {
  private projectRoot: string;
  private cache: Map<string, string[]> = new Map();
  private globalPatterns: string[] | undefined;
  // Cumulative .gitignore patterns from projectRoot down to a directory
  // (inclusive). Used to rebuild an ignore instance only when a directory
  // actually has its own .gitignore.
  private dirPatternsCache: Map<string, string[]> = new Map();
  // A built ignore instance per directory; directories without their own
  // .gitignore reuse their parent's instance, so on large workspaces only a
  // handful of unique instances are ever built.
  private dirIgnoreCache: Map<string, ReturnType<typeof ignore>> = new Map();

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  private loadPatternsForFile(patternsFilePath: string): string[] {
    let content: string;
    try {
      content = fs.readFileSync(patternsFilePath, 'utf-8');
    } catch (_error) {
      return [];
    }

    const isExcludeFile = patternsFilePath.endsWith(
      path.join('.git', 'info', 'exclude'),
    );

    const relativeBaseDir = isExcludeFile
      ? '.'
      : path.dirname(path.relative(this.projectRoot, patternsFilePath));

    return content
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p !== '' && !p.startsWith('#'))
      .map((p) => {
        const isNegative = p.startsWith('!');
        if (isNegative) {
          p = p.substring(1);
        }

        const isAnchoredInFile = p.startsWith('/');
        if (isAnchoredInFile) {
          p = p.substring(1);
        }

        // An empty pattern can result from a negated pattern like `!`,
        // which we can ignore.
        if (p === '') {
          return '';
        }

        let newPattern = p;
        if (relativeBaseDir && relativeBaseDir !== '.') {
          // Only in nested .gitignore files, the patterns need to be modified according to:
          // - If `a/b/.gitignore` defines `/c` then it needs to be changed to `/a/b/c`
          // - If `a/b/.gitignore` defines `c` then it needs to be changed to `/a/b/**/c`
          // - If `a/b/.gitignore` defines `c/d` then it needs to be changed to `/a/b/c/d`

          if (!isAnchoredInFile && !p.includes('/')) {
            // If no slash and not anchored in file, it matches files in any
            // subdirectory.
            newPattern = path.join('**', p);
          }

          // Prepend the .gitignore file's directory.
          newPattern = path.join(relativeBaseDir, newPattern);

          // Anchor the pattern to a nested gitignore directory.
          if (!newPattern.startsWith('/')) {
            newPattern = '/' + newPattern;
          }
        }

        // Anchor the pattern if originally anchored
        if (isAnchoredInFile && !newPattern.startsWith('/')) {
          newPattern = '/' + newPattern;
        }

        if (isNegative) {
          newPattern = '!' + newPattern;
        }

        // Even in windows, Ignore expects forward slashes.
        newPattern = newPattern.replace(/\\/g, '/');

        return newPattern;
      })
      .filter((p) => p !== '');
  }

  isIgnored(filePath: string): boolean {
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }

    try {
      const resolved = path.resolve(this.projectRoot, filePath);
      const relativePath = path.relative(this.projectRoot, resolved);

      if (
        relativePath === '' ||
        !isPathWithinRoot(resolved, this.projectRoot)
      ) {
        return false;
      }

      // Even in windows, Ignore expects forward slashes.
      const normalizedPath = relativePath.replace(/\\/g, '/');

      if (normalizedPath.startsWith('/') || normalizedPath === '') {
        return false;
      }

      if (this.globalPatterns === undefined) {
        const excludeFile = path.join(
          this.projectRoot,
          '.git',
          'info',
          'exclude',
        );
        this.globalPatterns = fs.existsSync(excludeFile)
          ? this.loadPatternsForFile(excludeFile)
          : [];
      }

      // Build (or reuse) the ignore instance covering all .gitignore files
      // from the project root down to the file's parent directory.
      const parentDir = path.dirname(resolved);
      const ig = this.buildIgnoreInstance(parentDir);

      return ig.ignores(normalizedPath);
    } catch (_error) {
      return false;
    }
  }

  /**
   * Returns the ignore instance for a directory, covering every .gitignore
   * file from the project root down to that directory. Directories without
   * their own .gitignore reuse their parent's instance, so building is done
   * once per distinct pattern set instead of once per directory.
   */
  // [nessy-fork] glob-ignore-pruning
  private buildIgnoreInstance(dirAbs: string): ReturnType<typeof ignore> {
    const cached = this.dirIgnoreCache.get(dirAbs);
    if (cached) {
      return cached;
    }

    if (dirAbs === this.projectRoot) {
      const patterns = this.loadOwnPatterns(dirAbs);
      this.dirPatternsCache.set(dirAbs, patterns);
      const ig = ignore();
      ig.add('.git');
      ig.add(this.globalPatterns ?? []);
      ig.add(patterns);
      this.dirIgnoreCache.set(dirAbs, ig);
      return ig;
    }

    const parentAbs = path.dirname(dirAbs);
    const parentIg = this.buildIgnoreInstance(parentAbs);

    // If the parent directory is itself ignored, the whole subtree is ignored
    // and its own .gitignore must not be applied (git semantics — nothing
    // inside an ignored directory can be re-included).
    const relParent = path.relative(this.projectRoot, parentAbs);
    if (relParent && parentIg.ignores(relParent.replace(/\\/g, '/'))) {
      this.dirIgnoreCache.set(dirAbs, parentIg);
      this.dirPatternsCache.set(dirAbs, this.dirPatternsCache.get(parentAbs)!);
      return parentIg;
    }

    const own = this.loadOwnPatterns(dirAbs);
    if (own.length === 0) {
      // No local .gitignore — the pattern set is identical to the parent's.
      this.dirIgnoreCache.set(dirAbs, parentIg);
      this.dirPatternsCache.set(dirAbs, this.dirPatternsCache.get(parentAbs)!);
      return parentIg;
    }

    const all = [...(this.dirPatternsCache.get(parentAbs) ?? []), ...own];
    this.dirPatternsCache.set(dirAbs, all);
    const ig = ignore();
    ig.add('.git');
    ig.add(this.globalPatterns ?? []);
    ig.add(all);
    this.dirIgnoreCache.set(dirAbs, ig);
    return ig;
  }

  private loadOwnPatterns(dirAbs: string): string[] {
    let patterns = this.cache.get(dirAbs);
    if (patterns === undefined) {
      const gitignorePath = path.join(dirAbs, '.gitignore');
      patterns = fs.existsSync(gitignorePath)
        ? this.loadPatternsForFile(gitignorePath)
        : [];
      this.cache.set(dirAbs, patterns);
    }
    return patterns;
  }
}

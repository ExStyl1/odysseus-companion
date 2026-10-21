/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitIgnoreFilter } from '../utils/gitIgnoreParser.js';
import type { NessyIgnoreFilter } from '../utils/nessyIgnoreParser.js';
import { GitIgnoreParser } from '../utils/gitIgnoreParser.js';
import {
  formatNessyIgnoreFileNames,
  NessyIgnoreParser,
} from '../utils/nessyIgnoreParser.js';
import { isGitRepository } from '../utils/gitUtils.js';
import * as path from 'node:path';

export interface FilterFilesOptions {
  respectGitIgnore?: boolean;
  respectNessyIgnore?: boolean;
}

export interface FilterReport {
  filteredPaths: string[];
  gitIgnoredCount: number;
  nessyIgnoredCount: number;
}

export class FileDiscoveryService {
  private gitIgnoreFilter: GitIgnoreFilter | null = null;
  private nessyIgnoreFilter: NessyIgnoreFilter | null = null;
  private projectRoot: string;

  constructor(
    projectRoot: string,
    private readonly customIgnoreFiles?: string[],
  ) {
    this.projectRoot = path.resolve(projectRoot);
    if (isGitRepository(this.projectRoot)) {
      this.gitIgnoreFilter = new GitIgnoreParser(this.projectRoot);
    }
    this.nessyIgnoreFilter = new NessyIgnoreParser(
      this.projectRoot,
      customIgnoreFiles,
    );
  }

  /**
   * Filters a list of file paths based on git and AI ignore rules.
   */
  filterFiles(
    filePaths: string[],
    options: FilterFilesOptions = {
      respectGitIgnore: true,
      respectNessyIgnore: true,
    },
  ): string[] {
    return filePaths.filter((filePath) => {
      if (options.respectGitIgnore && this.shouldGitIgnoreFile(filePath)) {
        return false;
      }
      if (options.respectNessyIgnore && this.shouldNessyIgnoreFile(filePath)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Filters a list of file paths based on git ignore rules and returns a report
   * with counts of ignored files.
   */
  filterFilesWithReport(
    filePaths: string[],
    opts: FilterFilesOptions = {
      respectGitIgnore: true,
      respectNessyIgnore: true,
    },
  ): FilterReport {
    const filteredPaths: string[] = [];
    let gitIgnoredCount = 0;
    let nessyIgnoredCount = 0;

    for (const filePath of filePaths) {
      if (opts.respectGitIgnore && this.shouldGitIgnoreFile(filePath)) {
        gitIgnoredCount++;
        continue;
      }

      if (opts.respectNessyIgnore && this.shouldNessyIgnoreFile(filePath)) {
        nessyIgnoredCount++;
        continue;
      }

      filteredPaths.push(filePath);
    }

    return {
      filteredPaths,
      gitIgnoredCount,
      nessyIgnoredCount,
    };
  }

  /**
   * Checks if a single file should be git-ignored
   */
  shouldGitIgnoreFile(filePath: string): boolean {
    if (this.gitIgnoreFilter) {
      return this.gitIgnoreFilter.isIgnored(filePath);
    }
    return false;
  }

  /**
   * Checks if a single file should be ignored by Nessy/agent ignore files.
   */
  shouldNessyIgnoreFile(filePath: string): boolean {
    if (this.nessyIgnoreFilter) {
      return this.nessyIgnoreFilter.isIgnored(filePath);
    }
    return false;
  }

  /**
   * Unified method to check if a file should be ignored based on filtering options
   */
  shouldIgnoreFile(
    filePath: string,
    options: FilterFilesOptions = {},
  ): boolean {
    const {
      respectGitIgnore = true,
      respectNessyIgnore: respectNessyIgnore = true,
    } = options;

    if (respectGitIgnore && this.shouldGitIgnoreFile(filePath)) {
      return true;
    }
    if (respectNessyIgnore && this.shouldNessyIgnoreFile(filePath)) {
      return true;
    }
    return false;
  }

  /**
   * Returns loaded patterns from Nessy/agent ignore files.
   */
  getNessyIgnorePatterns(): string[] {
    return this.nessyIgnoreFilter?.getPatterns() ?? [];
  }

  getNessyIgnoreFileDisplayForPath(filePath: string): string {
    return (
      this.nessyIgnoreFilter?.getIgnoreFileNameForPath(filePath) ??
      this.getNessyIgnoreFileNamesDisplay()
    );
  }

  getNessyIgnoreFileNamesDisplay(): string {
    return formatNessyIgnoreFileNames(this.customIgnoreFiles);
  }
}

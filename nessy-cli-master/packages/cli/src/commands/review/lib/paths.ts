/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Centralised path constants and helpers for the `nessy review` subcommands.
// All paths are relative to the project root (the current working directory
// when the command is invoked). Use `path.join` rather than string
// concatenation so Windows backslashes are produced when needed.

import { join } from 'node:path';

export const REVIEW_TMP_DIR = join('.nessy', 'tmp');
export const REVIEWS_DIR = join('.nessy', 'reviews');
export const REVIEW_CACHE_DIR = join('.nessy', 'review-cache');

/** Worktree path for a given MR review session. */
export function worktreePath(prNumber: string | number): string {
  return join(REVIEW_TMP_DIR, `review-mr-${prNumber}`);
}

/** Local branch ref name for a fetched MR head. */
export function reviewBranch(prNumber: string | number): string {
  return `nessy-review/mr-${prNumber}`;
}

/**
 * Per-target side-file path (review JSON, MR context, presubmit report).
 *
 * Files live under `.nessy/tmp/` rather than the OS temp dir so the path is
 * stable across platforms (macOS's `os.tmpdir()` returns `/var/folders/...`,
 * not `/tmp` — using the project-local dir avoids that mismatch entirely)
 * and so they're scoped to the project rather than the user's whole machine.
 */
export function tmpFile(target: string, suffix: string): string {
  return join(REVIEW_TMP_DIR, `nessy-review-${target}-${suffix}`);
}

/** Filename prefix used by `tmpFile`; useful for cleanup globbing. */
export function tmpPrefix(target: string): string {
  return `nessy-review-${target}-`;
}

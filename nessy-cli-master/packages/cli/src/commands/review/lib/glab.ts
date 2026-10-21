/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Thin wrapper around the GitLab CLI (`glab`) for the `nessy review`
// subcommands. All callers go through `execFileSync` (no shell) so quoting
// and escaping is consistent across macOS, Linux, and Windows.

import { execFileSync } from 'node:child_process';

/** Run `glab` with args. Returns stdout, trimmed and CRLF-normalised. */
export function glab(...args: string[]): string {
  return execFileSync('glab', args, { encoding: 'utf8' })
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Run `glab api <path>` (optionally with `--jq <expr>`) and JSON-parse the
 * result. Returns null when the response is empty (e.g. 204 / no content).
 */
export function glabApi(path: string, jq?: string): unknown {
  const args = ['api', path];
  if (jq) args.push('--jq', jq);
  const out = glab(...args);
  return out ? JSON.parse(out) : null;
}

/**
 * Run `glab api --paginate <path>` and JSON-parse the merged result.
 *
 * Use this for endpoints that return arrays and may have more than 30
 * (the default `per_page`) entries — MR notes, discussions, etc.
 * `glab --paginate` walks every `next` link and concatenates
 * each page's array into a single top-level array, so a single
 * `JSON.parse` recovers the full set.
 *
 * Returns `[]` for empty responses or non-array payloads (defensive — the
 * endpoint may legitimately return an object on a 4xx-style 200, e.g. an
 * error envelope).
 */
export function glabApiAll(path: string): unknown[] {
  const out = glab('api', '--paginate', path);
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

/** Login of the currently authenticated GitLab user. */
export function currentUser(): string {
  return glab('api', 'user', '--jq', '.username');
}

/**
 * Verify `glab` is installed and authenticated. Throws a clear error if not —
 * subcommands call this first so missing-auth failures don't show up as
 * cryptic 401s mid-run.
 */
export function ensureAuthenticated(): void {
  try {
    execFileSync('glab', ['auth', 'status'], { stdio: 'pipe' });
  } catch {
    throw new Error(
      'glab is not authenticated. Run `glab auth login --hostname gitlab.tcsbank.ru` and retry.',
    );
  }
}

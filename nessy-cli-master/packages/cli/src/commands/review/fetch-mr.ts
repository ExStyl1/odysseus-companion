/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `nessy review fetch-mr`: prepare an MR review's working state in a single
// deterministic pass.
//
//   1. Clean any stale worktree / branch from a previously interrupted run
//      so the new run starts fresh.
//   2. `git fetch <remote> merge-requests/<n>/head:nessy-review/mr-<n>` — fetch the MR
//      HEAD into a unique local ref (does not modify the user's working
//      tree, unlike `glab mr checkout`).
//   3. `glab mr view ...` to fetch metadata (head/base ref names, head SHA,
//      diff stats, cross-repo flag).
//   4. `git worktree add` to create an ephemeral worktree at
//      `.nessy/tmp/review-mr-<n>` so subsequent steps can run in isolation.
//   5. Emit a single JSON report describing the resulting state, which the
//      LLM reads to drive the rest of Step 1.

import type { CommandModule } from 'yargs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { ensureAuthenticated, glab } from './lib/glab.js';
import { git, refExists } from './lib/git.js';
import { REVIEW_TMP_DIR, reviewBranch, worktreePath } from './lib/paths.js';

interface PrMetadata {
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  isCrossRepository: boolean;
}

interface FetchPrArgs {
  pr_number: string;
  owner_repo: string;
  remote: string;
  out: string;
}

interface FetchPrResult {
  prNumber: string;
  ownerRepo: string;
  remote: string;
  ref: string;
  fetchedSha: string;
  worktreePath: string;
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
  diffStat: { files: number; additions: number; deletions: number };
}

function tryRemove(action: () => void): void {
  try {
    action();
  } catch {
    /* idempotent — silent on missing target */
  }
}

function cleanStale(prNumber: string): void {
  const wt = worktreePath(prNumber);
  if (existsSync(wt)) {
    tryRemove(() =>
      execFileSync('git', ['worktree', 'remove', wt, '--force'], {
        stdio: 'pipe',
      }),
    );
  }
  const ref = reviewBranch(prNumber);
  if (refExists(ref)) {
    tryRemove(() =>
      execFileSync('git', ['branch', '-D', ref], { stdio: 'pipe' }),
    );
  }
}

async function runFetchPr(args: FetchPrArgs): Promise<void> {
  const { pr_number: prNumber, owner_repo: ownerRepo, remote, out } = args;

  if (ownerRepo.indexOf('/') < 0) {
    throw new Error('owner_repo must look like "owner/repo"');
  }

  ensureAuthenticated();

  // 1. Clean any stale worktree / branch from an earlier run.
  cleanStale(prNumber);

  // 2. Fetch MR HEAD into a unique local ref.
  const ref = reviewBranch(prNumber);
  try {
    git('fetch', remote, `merge-requests/${prNumber}/head:${ref}`);
  } catch (err) {
    throw new Error(
      `Failed to fetch MR #${prNumber} from remote "${remote}": ${(err as Error).message}`,
    );
  }
  const fetchedSha = git('rev-parse', ref);

  // 3. Fetch MR metadata via glab CLI. Cross-repo flag tells the LLM whether
  //    to switch into lightweight mode.
  let meta: PrMetadata;
  try {
    const json = glab(
      'mr',
      'view',
      prNumber,
      '--repo',
      ownerRepo,
      '--json',
      'headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,isCrossRepository',
    );
    meta = JSON.parse(json) as PrMetadata;
  } catch (err) {
    // Roll back the fetched ref so the next run starts clean.
    tryRemove(() =>
      execFileSync('git', ['branch', '-D', ref], { stdio: 'pipe' }),
    );
    throw new Error(
      `Failed to fetch MR #${prNumber} metadata: ${(err as Error).message}`,
    );
  }

  // 4. Create the ephemeral worktree.
  const wt = worktreePath(prNumber);
  try {
    mkdirSync(dirname(wt), { recursive: true });
    git('worktree', 'add', wt, ref);
  } catch (err) {
    tryRemove(() =>
      execFileSync('git', ['branch', '-D', ref], { stdio: 'pipe' }),
    );
    throw new Error(
      `Failed to create worktree at ${wt}: ${(err as Error).message}`,
    );
  }

  // 5. Emit the report.
  const result: FetchPrResult = {
    prNumber,
    ownerRepo,
    remote,
    ref,
    fetchedSha,
    worktreePath: wt,
    baseRefName: meta.baseRefName,
    headRefName: meta.headRefName,
    isCrossRepository: meta.isCrossRepository,
    diffStat: {
      files: meta.changedFiles,
      additions: meta.additions,
      deletions: meta.deletions,
    },
  };

  mkdirSync(REVIEW_TMP_DIR, { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  writeStdoutLine(`Wrote fetch-mr report to ${out}`);
  // Surface diff stats to stderr so a human running the command interactively
  // sees something useful even without inspecting the JSON.
  writeStderrLine(
    `MR #${prNumber} (${ownerRepo}): ${meta.changedFiles} files, +${meta.additions}/-${meta.deletions}, base=${meta.baseRefName}, head=${meta.headRefName}`,
  );
}

export const fetchMrCommand: CommandModule = {
  command: 'fetch-mr <pr_number> <owner_repo>',
  describe:
    'Prepare a MR review worktree: clean stale state, fetch the MR HEAD, create a worktree, and write a JSON state report',
  builder: (yargs) =>
    yargs
      .positional('pr_number', {
        type: 'string',
        demandOption: true,
        describe: 'MR number',
      })
      .positional('owner_repo', {
        type: 'string',
        demandOption: true,
        describe: 'GitLab "owner/repo"',
      })
      .option('remote', {
        type: 'string',
        default: 'origin',
        describe:
          'Git remote to fetch from (use "upstream" for fork-based workflows)',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path (will be overwritten)',
      }),
  handler: async (argv) => {
    await runFetchPr(argv as unknown as FetchPrArgs);
  },
};

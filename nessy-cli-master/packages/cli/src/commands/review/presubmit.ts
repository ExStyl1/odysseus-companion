/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Pre-submission checks for /review Step 9. Runs three deterministic
// GitLab API queries and emits a single JSON report describing self-MR status,
// CI / build status, existing Nessy CLI comment classification, and the
// downgrade decisions the LLM should apply when constructing the review
// event.

import type { CommandModule } from 'yargs';
import { writeFileSync, readFileSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  glab,
  glabApiAll,
  currentUser,
  ensureAuthenticated,
} from './lib/glab.js';

interface FindingAnchor {
  path: string;
  line: number;
}

interface CommentSummary {
  id: number;
  path: string;
  line: number;
  commit_id: string;
  body: string;
}

interface RawComment {
  id: number;
  body?: string;
  path?: string;
  line?: number;
  commit_id?: string;
  in_reply_to_id?: number;
}

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

interface CommitStatus {
  context?: string;
  name?: string;
  state?: string;
  status?: string;
}

const FAIL_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
]);
const FAIL_STATUS_STATES = new Set(['failure', 'error']);
const PENDING_STATES = new Set(['queued', 'in_progress', 'pending']);

interface PresubmitArgs {
  pr_number: string;
  commit_sha: string;
  owner_repo: string;
  out_path: string;
  'new-findings'?: string;
}

function gitlabProjectPath(ownerRepo: string): string {
  return encodeURIComponent(ownerRepo);
}

function classifyCi(checkRuns: CheckRun[], statuses: CommitStatus[]) {
  const failedCheckNames: string[] = [];
  let hasPending = false;

  for (const run of checkRuns) {
    if (run.status === 'completed') {
      if (run.conclusion && FAIL_CONCLUSIONS.has(run.conclusion)) {
        failedCheckNames.push(run.name);
      }
    } else if (PENDING_STATES.has(run.status)) {
      hasPending = true;
    }
  }
  for (const s of statuses) {
    const state = s.state ?? s.status ?? '';
    const name = s.context ?? s.name ?? 'commit status';
    if (FAIL_STATUS_STATES.has(state)) {
      failedCheckNames.push(name);
    } else if (PENDING_STATES.has(state)) {
      hasPending = true;
    }
  }

  let cls: 'all_pass' | 'any_failure' | 'all_pending' | 'no_checks';
  if (failedCheckNames.length > 0) {
    cls = 'any_failure';
  } else if (checkRuns.length === 0 && statuses.length === 0) {
    cls = 'no_checks';
  } else if (hasPending) {
    cls = 'all_pending';
  } else {
    cls = 'all_pass';
  }

  return {
    class: cls,
    failedCheckNames,
    totalChecks: checkRuns.length + statuses.length,
  };
}

function classifyExistingComments(
  nessyComments: RawComment[],
  repliedToIds: Set<number>,
  newFindingKeys: Set<string>,
  commitSha: string,
) {
  const buckets: Record<
    'stale' | 'resolved' | 'overlap' | 'noConflict',
    CommentSummary[]
  > = { stale: [], resolved: [], overlap: [], noConflict: [] };

  for (const c of nessyComments) {
    const summary: CommentSummary = {
      id: c.id,
      path: c.path ?? '',
      line: c.line ?? 0,
      commit_id: c.commit_id ?? '',
      body: (c.body || '').slice(0, 80),
    };
    // Priority: Stale > Resolved > Overlap > NoConflict.
    if (c.commit_id !== commitSha) {
      buckets.stale.push(summary);
    } else if (repliedToIds.has(c.id)) {
      buckets.resolved.push(summary);
    } else if (newFindingKeys.has(`${c.path}:${c.line}`)) {
      buckets.overlap.push(summary);
    } else {
      buckets.noConflict.push(summary);
    }
  }
  return buckets;
}

async function runPresubmit(args: PresubmitArgs): Promise<void> {
  const {
    pr_number: prNumber,
    commit_sha: commitSha,
    owner_repo: ownerRepo,
    out_path: outPath,
  } = args;
  const newFindingsPath = args['new-findings'];

  const slash = ownerRepo.indexOf('/');
  if (slash < 0) {
    throw new Error('owner_repo must look like "owner/repo"');
  }
  const projectPath = gitlabProjectPath(ownerRepo);

  ensureAuthenticated();

  // --- Self-MR detection -------------------------------------------------
  const author = glab(
    'api',
    `/projects/${projectPath}/merge_requests/${prNumber}`,
    '--jq',
    '.author.username',
  );
  const me = currentUser();
  const isSelfPr = author.toLowerCase() === me.toLowerCase();

  // --- CI status ---------------------------------------------------------
  const checkRuns: CheckRun[] = [];
  const statuses = glabApiAll(
    `/projects/${projectPath}/repository/commits/${commitSha}/statuses`,
  ) as CommitStatus[];
  const ciStatus = classifyCi(checkRuns, statuses);

  // --- Existing Nessy CLI comments --------------------------------------
  // Paginate: MRs can have >30 inline comments and the latest pages carry
  // the most recent (and most likely to overlap with new findings).
  const allComments = glabApiAll(
    `/projects/${projectPath}/merge_requests/${prNumber}/notes`,
  ) as RawComment[];
  const nessyComments = allComments.filter((c) =>
    /via Nessy CLI \/review/.test(c.body ?? ''),
  );

  const repliedToIds = new Set<number>();
  for (const c of allComments) {
    if (c.in_reply_to_id) repliedToIds.add(c.in_reply_to_id);
  }

  let newFindings: FindingAnchor[] = [];
  if (newFindingsPath) {
    newFindings = JSON.parse(readFileSync(newFindingsPath, 'utf8'));
  }
  const newFindingKeys = new Set(newFindings.map((f) => `${f.path}:${f.line}`));

  const buckets = classifyExistingComments(
    nessyComments,
    repliedToIds,
    newFindingKeys,
    commitSha,
  );

  // --- Downgrade decisions ----------------------------------------------
  const downgradeReasons: string[] = [];
  if (isSelfPr) downgradeReasons.push('self-MR');
  if (ciStatus.class === 'any_failure') {
    downgradeReasons.push(
      `CI failing: ${ciStatus.failedCheckNames.join(', ')}`,
    );
  }
  if (ciStatus.class === 'all_pending') {
    downgradeReasons.push('CI still running');
  }

  const result = {
    prNumber,
    commitSha,
    ownerRepo,
    isSelfPr,
    ciStatus,
    existingComments: {
      total: nessyComments.length,
      byBucket: {
        stale: buckets.stale.length,
        resolved: buckets.resolved.length,
        overlap: buckets.overlap.length,
        noConflict: buckets.noConflict.length,
      },
      overlap: buckets.overlap,
      stale: buckets.stale,
      resolved: buckets.resolved,
      noConflict: buckets.noConflict,
    },
    downgradeApprove:
      isSelfPr ||
      ciStatus.class === 'any_failure' ||
      ciStatus.class === 'all_pending',
    downgradeRequestChanges: isSelfPr,
    downgradeReasons,
    blockOnExistingComments: buckets.overlap.length > 0,
  };

  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  writeStdoutLine(`Wrote presubmit report to ${outPath}`);
}

export const presubmitCommand: CommandModule = {
  command: 'presubmit <pr_number> <commit_sha> <owner_repo> <out_path>',
  describe:
    'Pre-submission checks for /review Step 9 (self-MR detection, CI status, existing-comments classification)',
  builder: (yargs) =>
    yargs
      .positional('pr_number', {
        type: 'string',
        demandOption: true,
        describe: 'MR number',
      })
      .positional('commit_sha', {
        type: 'string',
        demandOption: true,
        describe: 'MR HEAD commit SHA',
      })
      .positional('owner_repo', {
        type: 'string',
        demandOption: true,
        describe: 'GitLab "owner/repo"',
      })
      .positional('out_path', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path (will be overwritten)',
      })
      .option('new-findings', {
        type: 'string',
        describe:
          'Path to a JSON file shaped as [{path, line}, ...] — when provided, existing comments are checked for same-(path, line) overlap with the new findings.',
      }),
  handler: async (argv) => {
    await runPresubmit(argv as unknown as PresubmitArgs);
  },
};

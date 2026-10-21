/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Parent command for 'nessy review'. Hosts the deterministic helpers used by
// the /review skill (presubmit checks, post-review cleanup) so the prompt
// can stay short and the logic stays testable.

import type { Argv, CommandModule } from 'yargs';
import { fetchMrCommand } from './review/fetch-mr.js';
import { mrContextCommand } from './review/mr-context.js';
import { loadRulesCommand } from './review/load-rules.js';
import { deterministicCommand } from './review/deterministic.js';
import { presubmitCommand } from './review/presubmit.js';
import { cleanupCommand } from './review/cleanup.js';

export const reviewCommand: CommandModule = {
  command: 'review',
  describe:
    'Internal helpers used by the /review skill (MR worktree setup, context fetch, rules loading, deterministic analysis, presubmit checks, cleanup)',
  builder: (yargs: Argv) =>
    yargs
      .command(fetchMrCommand)
      .command(mrContextCommand)
      .command(loadRulesCommand)
      .command(deterministicCommand)
      .command(presubmitCommand)
      .command(cleanupCommand)
      .demandCommand(
        1,
        'Specify a subcommand: fetch-mr, mr-context, load-rules, deterministic, presubmit, or cleanup.',
      )
      .version(false),
  handler: () => {
    // yargs handles this via demandCommand(1) above.
  },
};

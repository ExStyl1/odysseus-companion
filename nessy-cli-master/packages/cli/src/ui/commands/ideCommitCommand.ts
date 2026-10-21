import { execSync } from 'node:child_process';
import { IdeClient, IDEConnectionStatus } from '@nestor/nessy-cli-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';

function execGit(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

function extractTaskId(branch: string): string | null {
  const match = branch.match(/([A-Z]+-\d+)/);
  return match ? match[1] : null;
}

export const ideCommitCommand: SlashCommand = {
  name: 'ide.commit',
  description: 'generate commit message from diff and set it in IDE',
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
  ): Promise<SlashCommandActionReturn> => {
    const ideClient = await IdeClient.getInstance();
    const { status } = ideClient.getConnectionStatus();

    if (status !== IDEConnectionStatus.Connected) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'IDE is not connected. Run /ide enable first.',
      };
    }

    if (!ideClient.isSetCommitMessageEnabled()) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'IDE does not support setCommitMessage. Make sure the IDE companion plugin is up to date.',
      };
    }

    const cwd = context.services.config?.getTargetDir() ?? process.cwd();
    const userNotes = context.invocation?.args?.trim() || '';

    // Collect git context
    let diff = execGit('git diff --staged', cwd);
    let diffSource = 'staged';
    if (!diff) {
      diff = execGit('git diff', cwd);
      diffSource = 'unstaged';
    }

    if (!diff) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No changes found (neither staged nor unstaged).',
      };
    }

    const branch = execGit('git rev-parse --abbrev-ref HEAD', cwd);
    const taskId = branch ? extractTaskId(branch) : null;
    const recentLogs = execGit('git log --oneline -5', cwd);

    // Build prompt
    let prompt = `IMPORTANT: You MUST call the set_commit_message tool with the generated message. This is a mandatory requirement — do NOT just output text, you MUST use the tool.

Generate a commit message for the following changes.

## Rules
- Follow conventional commits format: \`type(scope): description\`
- Types: feat, fix, refactor, chore, docs, test, style, perf, ci, build
- Keep the first line under 72 characters
- Add a body with details if the changes are non-trivial (separated by blank line)
- Write in the same language as the recent commit messages below (if available)
`;

    if (taskId) {
      prompt += `- Include task ID \`${taskId}\` at the beginning of the description, e.g.: \`feat[${taskId}]: description\`\n`;
    }

    if (userNotes) {
      prompt += `\n## User notes\n${userNotes}\n`;
    }

    prompt += `\n## Current branch\n${branch}\n`;
    prompt += `\n## Diff (${diffSource} changes)\n\`\`\`diff\n${diff}\n\`\`\`\n`;

    if (recentLogs) {
      prompt += `\n## Recent commits (for style reference)\n\`\`\`\n${recentLogs}\n\`\`\`\n`;
    }

    prompt += `\nYour FIRST action MUST be calling the set_commit_message tool with the generated commit message. Do NOT output the message as text first — call the tool immediately. Do NOT use any other tools.`;

    return {
      type: 'submit_prompt',
      content: prompt,
    };
  },
};

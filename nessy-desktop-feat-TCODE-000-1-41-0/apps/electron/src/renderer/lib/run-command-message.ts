/*
 * Source: v0.15.1:apps/electron/src/renderer/lib/run-command-message.ts (craft-agents-oss, Apache-2.0;
 * ADDED in v0.15.0), taken 1:1 by UB14.16. The text names Claude's `Bash` tool: Claude runs it with the
 * native `run_in_background`, Pi with our bash's `run_in_background`. Codex has no `Bash` tool and is a
 * stated residue until UB14.19 measures it on the binary; a codex wording, if one is needed, is a
 * follow-up row named after what codex's own tool accepts.
 */

/**
 * The message a "Run in background" button sends: it asks the agent to start the command as a
 * background Bash task (so the permission mode applies and a task chip shows it) and not to wait.
 * The fence is longer than any backtick run in the command, so the command can't end it early.
 */
export function runCommandMessage(command: string): string {
  const longestRun = Math.max(0, ...(command.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return [
    'Run this in the background (Bash with run_in_background: true), then continue without waiting for it:',
    '',
    `${fence}bash`,
    command,
    fence,
  ].join('\n')
}

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface SlashCommandArgs {
  command: string;
  arguments?: string;
}

const ALLOWED_SLASH_COMMANDS = new Set(['compact', 'help']);

function normalizeCommand(command: string): string {
  return command.trim().replace(/^\/+/, '').toLowerCase();
}

function buildCommand(command: string, args?: string): string {
  const trimmedArgs = args?.trim();
  return trimmedArgs ? `/${command} ${trimmedArgs}` : `/${command}`;
}

export async function handleSlashCommand(
  ctx: SessionToolContext,
  args: SlashCommandArgs
): Promise<ToolResult> {
  const command = normalizeCommand(args.command ?? '');
  if (!ALLOWED_SLASH_COMMANDS.has(command)) {
    return errorResponse(`Unknown or blocked slash command: /${command || '(empty)'}. Allowed commands: /compact, /help.`);
  }

  if (command === 'help') {
    return successResponse([
      'Available agent-callable slash commands:',
      '- /compact [instructions]: compact the active session context.',
      '- /help: show this list.',
    ].join('\n'));
  }

  if (!ctx.dispatchSlashCommand) {
    return errorResponse('SlashCommand dispatch is not available in this context.');
  }

  try {
    const fullCommand = buildCommand(command, args.arguments);
    const result = await ctx.dispatchSlashCommand(fullCommand);
    return successResponse(result || `Slash command ${fullCommand} dispatched.`);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error));
  }
}

/**
 * MCP source prompts handlers — source_list_prompts / source_get_prompt.
 *
 * UB7.11 — the prompt half of upstream v0.15.1 `handlers/mcp-sources.ts`
 * (owner-confirmed OQ-B4-2 (c): model-callable MCP prompt tools as host session
 * tools on Pi, Claude and codex — no runtime has a model-facing prompt
 * mechanism of its own). Prompts are reusable instructions with arguments an
 * MCP server publishes beside its tools; the protocol calls and large-result
 * handling happen behind `ctx.mcpSources` (the session's MCP pool), which also
 * limits them to the session's enabled, connected sources.
 *
 * Upstream's resource half (`source_list_resources` / `source_read_resource`)
 * is deliberately NOT adopted (manifest, v0.15.1 group "chat/turn/tool-display
 * (5 display names)": "source_list_resources/source_read_resource not adopted —
 * resources native"): Claude and codex read resources through their own native
 * tools and Pi keeps its `pi-only` `list_mcp_resources` / `read_mcp_resource`
 * pair (B4-06 HAVE; the `<sources>` counts announcement upstream adds with
 * these handlers is DROP-c for the same reason).
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

const MCP_SOURCES_UNAVAILABLE =
  'MCP prompts are not available in this context.';

const TRUNCATED_NOTE = ' (the server has more; the list stops at the page limit)';

function toError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ============================================================
// source_list_prompts
// ============================================================

export interface SourceListPromptsArgs {
  sourceSlug: string;
}

export async function handleSourceListPrompts(
  ctx: SessionToolContext,
  args: SourceListPromptsArgs
): Promise<ToolResult> {
  if (!ctx.mcpSources) return errorResponse(MCP_SOURCES_UNAVAILABLE);
  const sourceSlug = args.sourceSlug?.trim();
  if (!sourceSlug) return errorResponse('sourceSlug is required.');

  try {
    const { prompts, truncated } = await ctx.mcpSources.listPrompts(sourceSlug);
    if (prompts.length === 0) {
      return successResponse(`Source "${sourceSlug}" publishes no prompts.`);
    }
    return successResponse(
      `${plural(prompts.length, 'prompt')} from "${sourceSlug}"${truncated ? TRUNCATED_NOTE : ''}. ` +
        `Get one with source_get_prompt, passing its required arguments.\n\n${JSON.stringify({ prompts }, null, 2)}`
    );
  } catch (error) {
    return errorResponse(`Failed to list prompts: ${toError(error)}`);
  }
}

// ============================================================
// source_get_prompt
// ============================================================

export interface SourceGetPromptArgs {
  sourceSlug: string;
  name: string;
  arguments?: Record<string, string>;
}

export async function handleSourceGetPrompt(
  ctx: SessionToolContext,
  args: SourceGetPromptArgs
): Promise<ToolResult> {
  if (!ctx.mcpSources) return errorResponse(MCP_SOURCES_UNAVAILABLE);
  const sourceSlug = args.sourceSlug?.trim();
  if (!sourceSlug) return errorResponse('sourceSlug is required.');
  const name = args.name?.trim();
  if (!name) return errorResponse('name is required. Use source_list_prompts to find one.');

  try {
    return successResponse(await ctx.mcpSources.getPrompt(sourceSlug, name, args.arguments));
  } catch (error) {
    return errorResponse(`Failed to get prompt "${name}": ${toError(error)}`);
  }
}

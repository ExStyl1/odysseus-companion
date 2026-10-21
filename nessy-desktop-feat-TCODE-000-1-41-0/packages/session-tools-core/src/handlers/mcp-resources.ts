import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface ListMcpResourcesArgs {
  server?: string;
}

export interface ReadMcpResourceArgs {
  server: string;
  uri: string;
}

/**
 * `list_mcp_resources` — the resources (and, since UB7.10, the resource
 * TEMPLATES) published by resource-advertising sources, or one source when
 * `server` is given. Each source's listing follows pagination. Read-only, no
 * permission.
 *
 * The tool is only projected onto the surface when a connected source advertises
 * the resources capability (see `buildCurrentProxyToolDefinitions`), so the port
 * being absent here means the session lost its pool between projection and call.
 */
export async function handleListMcpResources(
  ctx: SessionToolContext,
  args: ListMcpResourcesArgs,
): Promise<ToolResult> {
  if (!ctx.mcpResources) {
    return errorResponse('list_mcp_resources is not available: this session has no connected MCP sources.');
  }
  const server = typeof args.server === 'string' ? args.server.trim() : '';
  try {
    const listing = await ctx.mcpResources.list(server || undefined);
    return successResponse(JSON.stringify(listing, null, 2));
  } catch (error) {
    return errorResponse(`list_mcp_resources failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * `read_mcp_resource` — read one resource by source slug + uri, as agent-ready
 * text (UB7.10, upstream v0.15.1 `readResource`): text contents joined, binary
 * contents saved to the session's downloads/ and described, and the
 * large-result guard tool results get. The read path is the pool's
 * `readResourceText`, which routes to the connected client for the slug.
 * Read-only, no permission.
 */
export async function handleReadMcpResource(
  ctx: SessionToolContext,
  args: ReadMcpResourceArgs,
): Promise<ToolResult> {
  if (!ctx.mcpResources) {
    return errorResponse('read_mcp_resource is not available: this session has no connected MCP sources.');
  }
  const server = typeof args.server === 'string' ? args.server.trim() : '';
  const uri = typeof args.uri === 'string' ? args.uri.trim() : '';
  if (!server || !uri) {
    return errorResponse('read_mcp_resource requires both a server slug and a resource uri.');
  }
  try {
    return successResponse(await ctx.mcpResources.read(server, uri));
  } catch (error) {
    return errorResponse(`read_mcp_resource failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

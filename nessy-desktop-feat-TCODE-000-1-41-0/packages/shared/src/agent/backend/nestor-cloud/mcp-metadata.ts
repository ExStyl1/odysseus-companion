import type { McpClientPool } from '../../../mcp/mcp-pool.ts';
import type { NestorMcpToolMetadata } from './metadata-builder.ts';
import { buildAdvertisedMcpName } from './tool-schema.ts';

type NestorCloudMcpMetadataPool = Pick<McpClientPool, 'getConnectedSlugs' | 'getTools' | 'isConnected' | 'slugsForLeaser'>;

/** `McpToolV1.Parameters` is `validate:"required"` (`a2a/extensions/tool_mcp.go:13-18`). */
const EMPTY_TOOL_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

export function buildNestorCloudMcpToolMetadata(
  mcpPool: NestorCloudMcpMetadataPool | undefined,
  intendedSlugs: string[],
  leaserId?: string,
): NestorMcpToolMetadata[] | undefined {
  if (!mcpPool) return undefined;

  const baseSlugs = intendedSlugs.length > 0
    ? intendedSlugs.filter((slug) => mcpPool.isConnected(slug))
    : mcpPool.getConnectedSlugs();
  // On a SHARED pool, scope to THIS session's leased slugs so another session's
  // connected servers never surface in this session's tool metadata. Absent a
  // leaserId (per-session private pool) the set is unchanged (pre-sharing).
  const scope = leaserId ? mcpPool.slugsForLeaser(leaserId) : undefined;
  const targetSlugs = scope ? baseSlugs.filter((slug) => scope.has(slug)) : baseSlugs;
  if (targetSlugs.length === 0) return undefined;

  // Advertise `server|tool` over the pool's minted `mcp__<slug>__<tool>` proxy name. The
  // backend hands `metadata.mcp[].name` to the model unchanged and echoes it back on the call
  // (`codeagent/agent.go:95-112`), and `server|tool` is the ONE inbound form the parser and
  // the reference connector agree on — the proxy name landed in `kind:'unknown'` and every
  // remote MCP call answered `Unsupported Nestor tool` (F3). The raw tool name is what
  // `McpClientPool.getProxyName(slug, originalName)` needs to resolve the executable proxy
  // name back, so the pair must survive the round trip un-minted.
  const tools: NestorMcpToolMetadata[] = [];
  for (const slug of targetSlugs) {
    for (const tool of mcpPool.getTools(slug, leaserId)) {
      // `$schema` is stripped for the same reason `getProxyToolDefs` strips it: an
      // unregistered meta-schema URI is rejected by strict validators downstream.
      const { $schema, ...schema } = (tool.inputSchema as Record<string, unknown> | undefined) ?? {};
      tools.push({
        name: buildAdvertisedMcpName(slug, tool.name),
        // Every advertised entry carries all of type/name/description/parameters (`type` is
        // stamped by the metadata builder). One item that fails `McpToolV1` validation does
        // not merely drop itself: the decode aborts at the first error
        // (`acoreslice.MapToValuesUntilFirstErr`) and the extension read returns nothing, so
        // the model loses the WHOLE MCP tool set.
        description: tool.description || `Tool from ${slug}`,
        parameters: Object.keys(schema).length > 0 ? schema : { ...EMPTY_TOOL_SCHEMA },
      });
    }
  }

  return tools.length > 0 ? tools : undefined;
}

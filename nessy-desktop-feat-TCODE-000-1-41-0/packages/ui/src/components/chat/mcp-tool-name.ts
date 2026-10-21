/**
 * Splitting an MCP wire name into the two halves a row is labelled with.
 *
 * **The separator is the DOUBLE underscore `__`, never a single one.** The
 * renderer used to split with `/^mcp__([^_]+)__(.+)$/`, and `[^_]+` stops at the
 * first `_`, so a wire name carrying one — `mcp__my_server_v2__whoami`, exactly
 * what the wire-name sanitizer mints from a server called `my server.v2` — did
 * not match at all and the raw `mcp__…` string reached the label.
 *
 * These functions mirror `resolveToolDisplayMeta` in server-core's
 * `SessionManager.ts` (read the symbol; F1.435 retired a line anchor here). The
 * renderer and server-core must never disagree about what a row is called — the
 * session tools' LABELS are one shared table since F1.434/F1.435
 * (`SESSION_TOOL_DISPLAY_NAMES`, `@nessy-agent/shared/utils/toolNames`), and
 * the name SPLIT below is kept in step by hand. The semantics, verbatim from there:
 *
 * - split on `__` and require at least 3 segments; segment 1 is the server and
 *   the rest, rejoined with `__`, is the tool;
 * - Codex reaches our source pool through the `[mcp_servers.sources]` bridge, so
 *   its ROW name — codex's raw `(server, tool)` pair, not the name its model is
 *   handed (F1.217) — is `mcp__sources__<wire>__<tool>` where Pi and Claude
 *   say `mcp__<wire>__<tool>`. The server that names the source is one segment
 *   later, so shift when segment 1 is `sources`, there are ≥4 segments, and
 *   segment 2 is non-empty. Wire names never contain `__` (the sanitizer
 *   collapses `_` runs), so segment 2 is exactly the wire name;
 * - that guard is what keeps a degenerate `mcp__sources__<x>` on the plain
 *   lookup rather than throwing, and leaves Pi names untouched — the Pi path
 *   strips `sources`, so a Pi row never has the bridge shape.
 */

/** The MCP server name our source pool is mounted under. */
const POOL_SERVER_MCP_NAME = 'sources'

export interface McpToolNameParts {
  /** The real server slug — already shifted past the codex `sources` bridge. */
  server: string
  /** The tool half, with any remaining `__` segments rejoined. */
  tool: string
}

/**
 * Split an MCP wire name into its server and tool halves.
 * Returns `undefined` for anything that is not an MCP wire name, so a non-MCP
 * name can be passed through byte-unchanged.
 */
export function parseMcpToolName(name: string): McpToolNameParts | undefined {
  if (!name.startsWith('mcp__')) return undefined

  const parts = name.split('__')
  if (parts.length < 3) return undefined

  if (parts[1] === POOL_SERVER_MCP_NAME && parts.length >= 4 && parts[2]) {
    return { server: parts[2], tool: parts.slice(3).join('__') }
  }

  return { server: parts[1]!, tool: parts.slice(2).join('__') }
}

/**
 * Strip the `mcp__<server>__` prefix, leaving the tool half.
 * A name that is not an MCP wire name is returned byte-unchanged.
 */
export function stripMcpToolPrefix(name: string): string {
  return parseMcpToolName(name)?.tool ?? name
}

// [nessy-fork] desktop-mcp-permission-args-preview
/**
 * Helpers for rendering MCP permission requests compactly.
 *
 * ACP delivers an MCP tool call as `toolName = mcp__<server>__<tool>` and puts the
 * stringified arguments into the request description, so the card has to normalize
 * both before it can show a one-line summary.
 */

export interface McpArguments {
  /** Single-line JSON for the compact card row */
  compact: string
  /** Pretty-printed JSON (2-space indent) for the side panel */
  pretty: string
}

/**
 * `mcp__dpWiki__get_page` → `dpWiki/get_page`.
 *
 * Only the `mcp__<server>__` prefix is split off — the tool name keeps any
 * double underscores of its own, and a non-MCP tool name is returned as is.
 */
export function formatMcpToolName(toolName: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName)
  return match ? `${match[1]}/${match[2]}` : toolName
}

/**
 * Parse the MCP tool arguments carried in the permission description.
 * Returns null when there is nothing worth previewing — the caller then falls
 * back to showing the raw description and hides the side panel button.
 */
export function parseMcpArguments(description?: string): McpArguments | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(description ?? '')
  } catch {
    return null
  }

  if (parsed === null || typeof parsed !== 'object') return null
  if (!Array.isArray(parsed) && Object.keys(parsed).length === 0) return null
  if (Array.isArray(parsed) && parsed.length === 0) return null

  return {
    compact: JSON.stringify(parsed),
    pretty: JSON.stringify(parsed, null, 2),
  }
}

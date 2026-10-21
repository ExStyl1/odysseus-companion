/**
 * The pure half of `InlineExecution` — the activity shape and the tool-event
 * mapper, kept out of the `.tsx` so the label rule can be tested without
 * loading the renderer tree (Markdown pulls react-pdf, which will not start
 * under `bun test`).
 *
 * `InlineExecution.tsx` re-exports both, so every existing import path still
 * works.
 */

import type { ActivityStatus } from './TurnCard'
import { stripMcpToolPrefix } from './mcp-tool-name'

export interface InlineActivityItem {
  id: string
  name: string
  status: ActivityStatus
  description?: string
}

/**
 * Map a tool event to an InlineActivityItem.
 * Use this when processing session events in EditPopover.
 */
export function mapToolEventToActivity(
  toolName: string,
  toolUseId: string,
  status: ActivityStatus,
  description?: string
): InlineActivityItem {
  // Clean up tool names (strip MCP prefixes for display).
  // The cut is `stripMcpToolPrefix`'s, not a regex: the separator is the DOUBLE
  // underscore, and the codex `sources` bridge adds one segment. Cutting at the
  // first single `_` used to leave the wire name in place, and the title-casing
  // below then rendered it as prose (`Mcp  My Server V2  Whoami`).
  const displayName = stripMcpToolPrefix(toolName)
    .replace(/_/g, ' ')            // Replace underscores with spaces
    .replace(/\b\w/g, c => c.toUpperCase())  // Title case

  return {
    id: toolUseId,
    name: displayName,
    status,
    description,
  }
}

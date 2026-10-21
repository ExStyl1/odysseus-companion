/**
 * F1.477 (P4) — the tool row's display name, moved out of `TurnCard.tsx`.
 *
 * `TurnCard.tsx` cannot be imported under `bun test` (its import graph reaches a
 * Vite-only `pdf.worker.min.mjs?url` specifier through Markdown), so every
 * decision left inside it could only be pinned by reading its source — which is
 * how F1.433's overlay-title test had to check this very resolver. P2.493 moved
 * the collapsed header's label and `getToolDisplayName` into `turn-preview.ts`
 * for the same reason; this is the same move for `formatToolDisplay`, byte for
 * byte (with its one private helper), and `TurnCard` imports it from here.
 * `@nessy-agent/ui` still exports it under the same name.
 */
import i18n from 'i18next'
import type { ActivityItem } from './TurnCard'
import { parseMcpToolName } from './mcp-tool-name'
import { getToolDisplayName } from './turn-preview'

/**
 * Extract the action portion from an LLM-provided displayName by stripping
 * a matching icon/tool prefix.
 *
 * Examples:
 *   extractActionFromDisplayName("Git", "Git Status")  → "Status"
 *   extractActionFromDisplayName("npm", "Install Deps") → "Install Deps"
 *   extractActionFromDisplayName("Git", "Check Branch")  → "Check Branch"
 */
function extractActionFromDisplayName(iconName: string, llmName: string): string {
  // If LLM name starts with the icon name, strip the prefix to get the action
  // "Git Status" with icon "Git" → "Status"
  if (llmName.toLowerCase().startsWith(iconName.toLowerCase() + ' ')) {
    return llmName.slice(iconName.length + 1).trim()
  }
  // Otherwise use the full LLM name as the action
  // "Install Dependencies" with icon "npm" → "Install Dependencies"
  return llmName
}

/**
 * Format tool display using embedded toolDisplayMeta.
 * toolDisplayMeta is set at storage time in the main process and includes:
 * - displayName: Human-readable name
 * - iconDataUrl: Base64-encoded icon (for skills/sources)
 * - description: Brief description
 * - category: 'skill' | 'source' | 'native' | 'mcp'
 */
export function formatToolDisplay(
  activity: ActivityItem
): { name: string; icon?: string; description?: string } {
  const { toolName, displayName, toolInput, toolDisplayMeta } = activity

  // Primary: Use embedded toolDisplayMeta (works in both Electron and viewer)
  if (toolDisplayMeta) {
    // For MCP tools, append the tool slug to the source name
    if (toolName?.startsWith('mcp__') && toolDisplayMeta.category === 'source') {
      const parts = parseMcpToolName(toolName)
      if (parts) {
        const toolSlug = parts.tool
        return {
          name: `${toolDisplayMeta.displayName}: ${toolSlug}`,
          icon: toolDisplayMeta.iconDataUrl,
          description: toolDisplayMeta.description,
        }
      }
    }

    // For Bash commands with LLM-provided displayName: merge icon name + action
    // e.g., icon "Git" + LLM "Git Status" → "Git: Status"
    // e.g., icon "npm" + LLM "Install Dependencies" → "npm: Install Dependencies"
    // Special case: for generic "Terminal", show only the action
    // e.g., icon "Terminal" + LLM "Install Dependencies" → "Install Dependencies"
    if (toolName === 'Bash' && displayName) {
      const iconName = toolDisplayMeta.displayName
      const action = extractActionFromDisplayName(iconName, displayName)
      return {
        name: iconName.toLowerCase() === 'terminal' ? action : `${iconName}: ${action}`,
        icon: toolDisplayMeta.iconDataUrl,
        description: toolDisplayMeta.description,
      }
    }

    // For native tools with LLM-provided displayName: use the LLM's name
    // This gives semantic names like "Read Config" instead of generic "Read"
    if (displayName && toolDisplayMeta.category === 'native') {
      return {
        name: displayName,
        icon: toolDisplayMeta.iconDataUrl,
        description: toolDisplayMeta.description,
      }
    }

    return {
      name: toolDisplayMeta.displayName,
      icon: toolDisplayMeta.iconDataUrl,
      description: toolDisplayMeta.description,
    }
  }

  // Fallback for Skill tool without toolDisplayMeta (legacy sessions)
  if (toolName === 'Skill' && toolInput?.skill) {
    const skillId = String(toolInput.skill)
    // Extract slug from qualified name (workspaceId:slug) for display
    const colonIdx = skillId.indexOf(':')
    const slug = colonIdx > 0 ? skillId.slice(colonIdx + 1) : skillId
    return { name: slug }
  }

  // Final fallback: Use LLM-generated displayName or tool name
  const name = displayName || (toolName ? getToolDisplayName(toolName) : i18n.t('turnCard.processing'))
  return { name }
}

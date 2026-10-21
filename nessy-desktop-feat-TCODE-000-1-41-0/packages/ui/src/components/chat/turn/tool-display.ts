/**
 * Source: v0.15.1:packages/ui/src/components/chat/turn/tool-display.ts (ADDED in v0.15.0, +5 names in v0.15.1;
 * UB14.11, R3-05).
 *
 * Re-plugged, not taken byte-equal (the row's Method):
 * - `formatToolDisplay` and `getToolDisplayName` are OURS, re-exported. Upstream's copies split an MCP
 *   name with `/^mcp__[^_]+__/` and `/^mcp__([^_]+)__(.+)$/`, which is exactly the bug
 *   `../mcp-tool-name.ts`'s header records: a wire name carrying one `_` does not match, and codex's
 *   `mcp__sources__<wire>__<tool>` bridge row (F1.217) names the bridge, not the source. Ours split on
 *   `__` through `parseMcpToolName` (F1.477) and read the session tools' labels from the ONE shared
 *   table, `SESSION_TOOL_DISPLAY_NAMES` (F1.434/F1.435) — upstream's five 0.15.1 names live there.
 * - `stripMarkdown` is OURS too (`../intermediate-row.ts`, byte-equal to upstream's), so the two
 *   modules cannot drift; that module stays the bun-loadable home of the intermediate-row decision.
 * - Everything else (`computeEditWriteDiffStats`, `stripSessionFolderPath`, `formatToolInput` with its
 *   `decide` arm, `getActivityFileName`) is upstream's code, moved out of our `TurnCard.tsx`, where
 *   the first three already lived verbatim.
 *
 * Pure helpers that turn an activity into display text (tool name, input summary, diff stats).
 * Moved out of TurnCard.tsx unchanged so the row components can share them.
 */
import { normalizePath, pathStartsWith, stripPathPrefix } from '@nessy-agent/core/utils'
import { parseDiffFromFile, type FileContents } from '@pierre/diffs'
import { getDiffStats, getUnifiedDiffStats } from '../../code-viewer'
import type { ActivityItem } from '../TurnCard'

export { formatToolDisplay } from '../tool-display'
export { getToolDisplayName } from '../turn-preview'
export { stripMarkdown } from '../intermediate-row'

/**
 * Compute diff stats for Edit/Write tool inputs.
 * Uses @pierre/diffs for accurate line-by-line diff calculation.
 *
 * Supports both:
 * - Claude Code format: { file_path, old_string, new_string }
 * - Codex format: { changes: Array<{ path, kind, diff }> }
 *
 * @param toolName - 'Edit' or 'Write'
 * @param toolInput - The tool input containing old_string/new_string (Edit) or content (Write)
 * @returns { additions, deletions } or null if not applicable
 */
export function computeEditWriteDiffStats(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): { additions: number; deletions: number } | null {
  if (!toolInput) return null

  if (toolName === 'Edit') {
    // Check for Codex format: { changes: Array<{ path, kind, diff }> }
    if (toolInput.changes && Array.isArray(toolInput.changes)) {
      let totalAdditions = 0
      let totalDeletions = 0
      for (const change of toolInput.changes as Array<{ path?: string; diff?: string }>) {
        if (change.diff) {
          const stats = getUnifiedDiffStats(change.diff, change.path || 'file')
          if (stats) {
            totalAdditions += stats.additions
            totalDeletions += stats.deletions
          }
        }
      }
      if (totalAdditions === 0 && totalDeletions === 0) return null
      return { additions: totalAdditions, deletions: totalDeletions }
    }

    // Claude Code format: { file_path, old_string, new_string }
    const oldString = (toolInput.old_string as string) ?? ''
    const newString = (toolInput.new_string as string) ?? ''
    if (!oldString && !newString) return null

    const oldFile: FileContents = { name: 'file', contents: oldString, lang: 'text' }
    const newFile: FileContents = { name: 'file', contents: newString, lang: 'text' }
    const fileDiff = parseDiffFromFile(oldFile, newFile)
    return getDiffStats(fileDiff)
  }

  if (toolName === 'Write') {
    const content = (toolInput.content as string) ?? ''
    if (!content) return null

    // For Write, everything is an addition (new file content)
    const oldFile: FileContents = { name: 'file', contents: '', lang: 'text' }
    const newFile: FileContents = { name: 'file', contents: content, lang: 'text' }
    const fileDiff = parseDiffFromFile(oldFile, newFile)
    return getDiffStats(fileDiff)
  }

  return null
}

/**
 * Strip session/workspace folder paths from file paths for cleaner display.
 * Only strips paths that match the current session folder path.
 * Example: /path/to/sessions/260121-foo/plans/file.md → plans/file.md
 */
export function stripSessionFolderPath(filePath: string, sessionFolderPath?: string): string {
  if (!sessionFolderPath) return filePath

  // Get workspace path (parent of sessions folder)
  // sessionFolderPath: /path/workspaces/{uuid}/sessions/{sessionId}
  const workspacePath = normalizePath(sessionFolderPath).replace(/\/sessions\/[^/]+$/, '')

  // Try session folder first (more specific)
  if (pathStartsWith(filePath, sessionFolderPath)) {
    return stripPathPrefix(filePath, sessionFolderPath)
  }

  // Then try workspace folder
  if (pathStartsWith(filePath, workspacePath)) {
    return stripPathPrefix(filePath, workspacePath)
  }

  return filePath
}

/** Format tool input as a concise summary - CSS truncate handles overflow */
export function formatToolInput(
  input?: Record<string, unknown>,
  toolName?: string,
  sessionFolderPath?: string
): string {
  if (!input || Object.keys(input).length === 0) return ''

  // For call_llm: model shown as badge, prompt duplicates intent
  if (toolName === 'mcp__session__call_llm') return ''
  // For decide: state/questions JSON is noise in a one-line summary; the intent
  // (and the overlay) carry the meaning
  if (toolName === 'mcp__session__decide') return ''

  const parts: string[] = []

  // For Edit/Write tools, only show file_path (skip old_string, new_string, replace_all, content)
  const isEditOrWrite = toolName === 'Edit' || toolName === 'Write'

  // Handle Codex format: { changes: Array<{ path, kind, diff }> }
  // Extract path from first change if present
  if (isEditOrWrite && input.changes && Array.isArray(input.changes)) {
    const firstChange = input.changes[0] as { path?: string } | undefined
    if (firstChange?.path) {
      const pathStr = stripSessionFolderPath(firstChange.path, sessionFolderPath)
      parts.push(pathStr)
    }
    return parts.join(' ')
  }

  for (const [key, value] of Object.entries(input)) {
    // Skip meta fields and description (shown separately)
    if (key === '_intent' || key === 'description' || value === undefined || value === null) continue

    // For Edit/Write tools, only include file_path
    if (isEditOrWrite && key !== 'file_path') continue

    let valStr = typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim()
      : JSON.stringify(value)

    // Strip session/workspace paths from file_path for Edit/Write tools
    if (isEditOrWrite && key === 'file_path' && typeof value === 'string') {
      valStr = stripSessionFolderPath(valStr, sessionFolderPath)
    }

    parts.push(valStr)
    if (parts.length >= 2) break // Max 2 values
  }
  return parts.join(' ')
}

/**
 * File name shown next to Edit/Write (when they have diff stats) and Read rows — the same
 * condition as the former filename badge. Supports Claude Code (`file_path`) and Codex
 * (`changes[0].path`) inputs.
 */
export function getActivityFileName(
  activity: ActivityItem,
  hasDiffStats: boolean
): string | undefined {
  const input = activity.toolInput
  if (!input) return undefined
  if (!hasDiffStats && activity.toolName !== 'Read') return undefined
  if (typeof input.file_path === 'string') {
    return normalizePath(input.file_path).split('/').pop()
  }
  if (hasDiffStats && Array.isArray(input.changes)) {
    const firstChange = input.changes[0] as { path?: string } | undefined
    if (firstChange?.path) return normalizePath(firstChange.path).split('/').pop()
  }
  return undefined
}

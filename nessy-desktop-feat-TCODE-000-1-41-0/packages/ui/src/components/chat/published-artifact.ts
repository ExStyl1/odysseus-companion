/**
 * UA1.19 — the artifact chip's DECISION, as a value (P2.493's convention: `TurnCard.tsx` cannot be loaded by bun, so
 * what it shows is decided here and asserted in `__tests__/published-artifact.test.ts`).
 *
 * A completed `publish_artifact` call answers `{ url, expires_at, updated, note }` (session-tools-core
 * `handlers/publish-artifact.ts` `publishedResult`). On Claude and codex the row's tool name is the MCP wire name
 * (`mcp__session__publish_artifact`); on Pi it is the bare name. The chip is drawn only for a link on the ONE
 * t-artifacts origin (`@nessy-agent/shared/artifacts/origin`): a result that names any other host is not ours and
 * gets no chip.
 *
 * UA1.20 follow-up — on Claude the native `Artifact` is ALIASED onto `mcp__session__publish_artifact`
 * (`CLAUDE_TOOL_ALIASES`, `packages/shared/src/agent/claude-agent.ts`). The alias changes only which tool runs; the
 * transcript row keeps the emitted name `Artifact`, so that key is accepted here too. Safe because the chip still
 * needs a completed result whose link is on the one origin (a claude.ai or other link draws nothing). The map-derived
 * guard is `packages/shared/src/agent/__tests__/claude-tool-aliases.test.ts`.
 */
import { isTArtifactsUrl } from '@nessy-agent/shared/artifacts/origin'

export interface PublishedArtifactChipData {
  url: string
  /** ISO timestamp, or `null` when the link never expires. */
  expiresAt: string | null
  updated: boolean
}

const TOOL = 'publish_artifact'
/** The Claude alias key that runs the tool under its native name (see the header). */
const CLAUDE_ALIAS = 'Artifact'

export function isPublishArtifactToolName(name: string | undefined): boolean {
  if (!name) return false
  return name === TOOL || name === `mcp__session__${TOOL}` || name === CLAUDE_ALIAS
}

/** The first JSON object in a tool result (the MCP envelope may wrap it in text). */
function firstJsonObject(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value: unknown = JSON.parse(content.slice(start, end + 1))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The chip for one tool row, or `null` (not the tool, not completed, not a link on the one origin). */
export function publishedArtifactChipData(activity: {
  toolName?: string
  status?: string
  content?: string
}): PublishedArtifactChipData | null {
  if (!isPublishArtifactToolName(activity.toolName) || activity.status !== 'completed' || !activity.content) return null
  const body = firstJsonObject(activity.content)
  if (!body || typeof body.url !== 'string' || !isTArtifactsUrl(body.url)) return null
  const expiresAt = typeof body.expires_at === 'string' ? body.expires_at : null
  return { url: body.url, expiresAt, updated: body.updated === true }
}

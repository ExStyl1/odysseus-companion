/** UA1.19 — the artifact chip's decision (`published-artifact.ts`), asserted on values. */
import { describe, expect, test } from 'bun:test'
import { publishedArtifactChipData, isPublishArtifactToolName } from '../published-artifact'

const URL_ = 'https://t-artifacts.t-tech.team/a/AbCdEfGhIjKlMnOpQrStUv'
const result = (body: Record<string, unknown>) => JSON.stringify(body, null, 2)

describe('UA1.19 artifact chip', () => {
  test('a completed publish on every runtime spelling gets the chip with the link and the absolute expiry', () => {
    for (const toolName of ['publish_artifact', 'mcp__session__publish_artifact']) {
      expect(publishedArtifactChipData({
        toolName, status: 'completed', content: result({ url: URL_, expires_at: '2026-10-09T00:00:00.000Z', updated: false, note: 'x' }),
      })).toEqual({ url: URL_, expiresAt: '2026-10-09T00:00:00.000Z', updated: false })
    }
    // Unlimited retention: no expiry; an update says so.
    expect(publishedArtifactChipData({ toolName: 'publish_artifact', status: 'completed', content: result({ url: URL_, expires_at: null, updated: true }) }))
      .toEqual({ url: URL_, expiresAt: null, updated: true })
  })

  test('negative: no chip for another tool, a running or failed call, a refusal sentence, or a link on another origin', () => {
    const ok = result({ url: URL_, expires_at: null, updated: false })
    expect(publishedArtifactChipData({ toolName: 'list_artifacts', status: 'completed', content: ok })).toBeNull()
    expect(publishedArtifactChipData({ toolName: 'mcp__other__publish_artifact', status: 'completed', content: ok })).toBeNull()
    expect(publishedArtifactChipData({ toolName: 'publish_artifact', status: 'running', content: ok })).toBeNull()
    expect(publishedArtifactChipData({ toolName: 'publish_artifact', status: 'error', content: ok })).toBeNull()
    expect(publishedArtifactChipData({ toolName: 'publish_artifact', status: 'completed', content: 'The publish was declined; nothing was sent.' })).toBeNull()
    expect(publishedArtifactChipData({ toolName: 'publish_artifact', status: 'completed', content: result({ url: 'https://claude.ai/a/x', expires_at: null }) })).toBeNull()
    expect(publishedArtifactChipData({ toolName: 'publish_artifact', status: 'completed', content: result({ url: 'https://user:pw@t-artifacts.t-tech.team/a/x' }) })).toBeNull()
    expect(isPublishArtifactToolName(undefined)).toBe(false)
  })
})

/**
 * UA1.20 follow-up — on Claude the native `Artifact` is ALIASED onto `mcp__session__publish_artifact`
 * (`CLAUDE_TOOL_ALIASES`), and the alias changes only which tool runs: the transcript row keeps the name the model
 * emitted. The map-derived half of this guard is `packages/shared/src/agent/__tests__/claude-tool-aliases.test.ts`
 * (importing `claude-agent.ts` here costs the whole agent module graph, measured past the 5 s test budget).
 */
describe('UA1.20 follow-up: an aliased Claude publish gets the chip', () => {
  const ok = result({ url: URL_, expires_at: null, updated: false })

  test('a completed Artifact row with a t-artifacts link draws the chip', () => {
    expect(publishedArtifactChipData({ toolName: 'Artifact', status: 'completed', content: ok }))
      .toEqual({ url: URL_, expiresAt: null, updated: false })
  })

  test('negative: an Artifact row naming another origin, or not completed, draws nothing; other names stay out', () => {
    expect(publishedArtifactChipData({ toolName: 'Artifact', status: 'completed', content: result({ url: 'https://claude.ai/code/artifact/x', expires_at: null }) })).toBeNull()
    expect(publishedArtifactChipData({ toolName: 'Artifact', status: 'error', content: ok })).toBeNull()
    expect(isPublishArtifactToolName('artifact')).toBe(false)
    expect(isPublishArtifactToolName('mcp__session__Artifact')).toBe(false)
    expect(isPublishArtifactToolName('Monitor')).toBe(false)
  })
})

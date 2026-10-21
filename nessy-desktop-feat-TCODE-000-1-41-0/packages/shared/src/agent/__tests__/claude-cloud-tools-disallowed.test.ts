/**
 * F1.253 — the vendored bundle's claude.ai cloud tools are denied on every
 * claude card.
 *
 * `sdk-tools.d.ts` (vendored `0.3.251`, CLI `2.1.251`) declares four tools that
 * act only through a claude.ai OAuth session — `Artifact` (publishes a page),
 * `Projects` (reads and writes a claude.ai project's knowledge base),
 * `ClaudeDesign` (server-validated design actions) and `RemoteTrigger` (cloud
 * triggers and their runs). None was in `CLAUDE_SESSION_DISALLOWED_TOOLS`, so on a
 * card that could reach claude.ai they could move session content to claude.ai
 * services outside this product's audit trail. DECIDED (controller, 2026-09-23):
 * deny all four on every claude card.
 *
 * ## Why the list is REVIEWED and not parsed out of the declarations
 *
 * The declarations carry no gating marker — `claude.ai` occurs ZERO times in
 * `sdk-tools.d.ts` (2026-09-23) — so "claude.ai-gated" cannot be derived from the
 * file's text, and a heuristic over descriptions would be a guess. The list is
 * therefore reviewed, pinned here against the declarations (each must still be
 * DECLARED, so a lift that drops one is seen), and a lift that ADDS a tool is
 * caught by the complement test in
 * `apps/electron/src/renderer/components/app-shell/input/__tests__/runtime-switch-costs-native-claude-tools.test.ts`,
 * whose failure names the new tool and asks for it to be classified.
 * `ProposeGoal` is local (the row's own reading) and stays out.
 *
 * `enableArtifact: false` rides the host's own settings contributor too — the
 * SDK documents it ("Off in any of managed, --settings, or user settings wins"),
 * so the Artifact tool is off at the runtime as well as withheld from the model.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CLAUDE_AI_CLOUD_TOOLS, CLAUDE_SESSION_DISALLOWED_TOOLS, claudeAiCloudToolSettings } from '../claude-agent.ts'

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url)), 'utf8')

const declaredTools = (): ReadonlySet<string> => new Set(
  [...repoFile('node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts')
    .matchAll(/^export interface ([A-Za-z]+)Input\b/gm)].map(match => match[1]!),
)

describe('F1.253 — claude.ai cloud tools are disallowed on every claude card', () => {
  it('the reviewed set is exactly the four, and every one is still declared by the vendored bundle', () => {
    expect([...CLAUDE_AI_CLOUD_TOOLS].sort()).toEqual(['Artifact', 'ClaudeDesign', 'Projects', 'RemoteTrigger'])
    const declared = declaredTools()
    // Instrument control: the parser reads real declarations.
    expect(declared.has('TaskCreate')).toBe(true)
    for (const name of CLAUDE_AI_CLOUD_TOOLS) expect(declared.has(name), `${name} left the bundle`).toBe(true)
  })

  it('every one is in CLAUDE_SESSION_DISALLOWED_TOOLS', () => {
    for (const name of CLAUDE_AI_CLOUD_TOOLS) expect(CLAUDE_SESSION_DISALLOWED_TOOLS).toContain(name)
  })

  it('NEGATIVE CONTROL: the local orchestration tools stay offered', () => {
    for (const name of ['Agent', 'Workflow', 'ProposeGoal']) expect(CLAUDE_SESSION_DISALLOWED_TOOLS).not.toContain(name)
  })

  it('enableArtifact: false is a documented SDK setting and the host contributes it', () => {
    expect(claudeAiCloudToolSettings()).toEqual({ enableArtifact: false })
    expect(repoFile('node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts')).toContain('enableArtifact?: boolean;')
    const agent = repoFile('packages/shared/src/agent/claude-agent.ts')
    expect(agent).toContain('cloudTools: claudeAiCloudToolSettings()')
  })
})

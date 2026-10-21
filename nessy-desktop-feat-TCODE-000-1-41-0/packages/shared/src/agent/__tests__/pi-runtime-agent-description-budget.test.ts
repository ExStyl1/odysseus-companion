/**
 * P6.315 — subagent descriptions spend from every turn's context and nothing
 * told you when they were over budget.
 *
 * ## The semantics are recovered, not invented
 *
 * The vendored native binary carries a startup-notice id
 * `large-agent-descriptions`: a reducer over active agents filtered to
 * `source !== "built-in"`, summing an estimate of `` `${agentType}: ${whenToUse}` ``
 * per agent, against a literal `15000`, tier `warning`.
 * `errors.md#agent-descriptions-are-over-the-15000-token-limit` agrees verbatim,
 * including the half that makes this a REPORT and not a gate: "Claude Code loads
 * every agent whether or not the total is over the limit, so the warning doesn't
 * change what loads."
 *
 * ## Why the host computes it
 *
 * The SDK's notice belongs to the CLI's Ink startup-notice list. We embed the
 * SDK, not the TUI, so it can never reach a Nessy session; Pi and codex have no
 * counterpart. Step 2 of native-first — the host supplies it once for all three
 * — and `materializePiRuntimeAgentDefinitions` is the seam every runtime's
 * definitions pass through. The capability RESOLVER cannot do it: a native
 * `.claude/agents/*.md` agent carries `description: ''` there — and, MEASURED
 * HERE, neither can the DESCRIPTOR this seam produces, for the same reason: it
 * copies `agent.description` off the view verbatim. The sum is taken from the
 * file's own frontmatter, which this seam has already read.
 *
 * ## What these cases pin
 *
 * The threshold, the built-in exclusion, the subject of the estimate (name plus
 * description, not description alone), and — the one that matters most — that
 * nothing is dropped when the budget is blown.
 */
import { describe, expect, it } from 'bun:test'

import type { AgentRuntimeView } from '../../capabilities/views.ts'
import {
  AGENT_DESCRIPTION_TOKEN_BUDGET,
  materializePiRuntimeAgentDefinitions,
  type PiRuntimeAgentDescriptionBudgetDiagnostic,
} from '../pi-harness/runtime-agent-definition.ts'

type ViewAgent = AgentRuntimeView['agents'][number]

function nativeAgent(name: string, description: string, scope: 'builtin' | 'global'): ViewAgent {
  return {
    key: `native://${scope}/${name}`,
    name,
    description,
    selectedAsUnqualifiedAlias: true,
    instructionsResource: {
      absolutePath: `/agents/${name}.md`,
      contentHash: 'a'.repeat(64),
      scope: { kind: scope },
    },
  } as unknown as ViewAgent
}

function viewOf(agents: ViewAgent[]): AgentRuntimeView {
  return {
    generation: 'generation-1',
    sources: [], skills: [], mcpServers: [], hooks: [], automations: [],
    agents,
    promptLayers: [], memory: [], permissionLayers: [],
    commands: [], promptCommands: [], apps: [],
  } as unknown as AgentRuntimeView
}

/** A frontmatter block whose `description` is `chars` long. */
function definitionFile(name: string, chars: number): string {
  return ['---', `name: ${name}`, `description: ${'d'.repeat(chars)}`, '---', 'Body.'].join('\n')
}

async function run(agents: ViewAgent[], sizes: Record<string, number>) {
  const fired: PiRuntimeAgentDescriptionBudgetDiagnostic[] = []
  const definitions = await materializePiRuntimeAgentDefinitions({
    view: viewOf(agents),
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { throw new Error('paths must not be transported') },
      async readText(resource: unknown) {
        const path = String((resource as { absolutePath?: string }).absolutePath ?? '')
        const name = path.replace('/agents/', '').replace('.md', '')
        return definitionFile(name, sizes[name] ?? 10)
      },
      resolveCredential() { throw new Error('not used') },
    } as never,
    onDescriptionsOverBudget: diagnostic => fired.push(diagnostic),
  })
  return { fired, definitions }
}

// 4 chars ≈ 1 token, so this is comfortably over 15 000 tokens on its own.
const OVER = AGENT_DESCRIPTION_TOKEN_BUDGET * 4 + 400

describe('P6.315 · the agent-description budget', () => {
  it('fires once over the limit, names the offenders largest first, and loads every definition anyway', async () => {
    const { fired, definitions } = await run(
      [nativeAgent('bloated', 'x', 'global'), nativeAgent('small', 'x', 'global')],
      { bloated: OVER, small: 40 },
    )

    expect(fired).toHaveLength(1)
    expect(fired[0]!.limit).toBe(15_000)
    expect(fired[0]!.estimatedTokens).toBeGreaterThan(15_000)
    expect(fired[0]!.offenders.map(o => o.name)).toEqual(['bloated', 'small'])
    expect(fired[0]!.offenders[0]!.file).toBe('/agents/bloated.md')

    // The page's own promise, and the reason this is a report: "Claude Code
    // loads every agent whether or not the total is over the limit".
    expect(definitions.map(d => d.name).sort()).toEqual(['bloated', 'small'])
  })

  it('is SILENT under the limit — the control', async () => {
    const { fired } = await run([nativeAgent('small', 'x', 'global')], { small: 40 })
    expect(fired).toEqual([])
  })

  it('EXCLUDES built-in agents, exactly as the binary and the page do', async () => {
    // An oversized BUILT-IN description is ours, not the user's, and there is
    // nothing they could trim. If this ever fires, the warning names a file the
    // user cannot edit.
    const { fired } = await run([nativeAgent('bundled', 'x', 'builtin')], { bundled: OVER })
    expect(fired).toEqual([])
  })

  it('counts the NAME as well as the description, which is the binary’s own subject', async () => {
    // Two agents whose descriptions are identical and whose names differ in
    // length must not produce the same estimate.
    const short = await run([nativeAgent('a', 'x', 'global')], { a: 40 })
    const long = await run([nativeAgent('a-very-long-agent-name-indeed', 'x', 'global')], {
      'a-very-long-agent-name-indeed': 40,
    })
    // Neither fires; the assertion is on the seam, so drive it through a case
    // that does by putting each over the limit instead.
    expect(short.fired).toEqual([])
    expect(long.fired).toEqual([])

    const shortOver = await run([nativeAgent('a', 'x', 'global')], { a: OVER })
    const longOver = await run([nativeAgent('a-very-long-agent-name-indeed', 'x', 'global')], {
      'a-very-long-agent-name-indeed': OVER,
    })
    expect(longOver.fired[0]!.estimatedTokens)
      .toBeGreaterThan(shortOver.fired[0]!.estimatedTokens)
  })
})

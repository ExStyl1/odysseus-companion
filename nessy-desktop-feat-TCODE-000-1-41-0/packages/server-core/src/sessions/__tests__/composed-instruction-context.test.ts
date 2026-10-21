/**
 * P2.451 — the codex compaction steering was one gate away, and this is the
 * gate.
 *
 * P2.436 landed the writer (`config-writer.ts`'s `compact_prompt`) and the
 * producer (`CodexAgent.codexCompactPromptOption`), both tested, both correct,
 * and together they emitted nothing: the context resources the producer reads
 * are `BackendConfig.piContextResources`, and `SessionManager` materialized them
 * behind `provider === 'pi'`. A codex session supplied none, so the projection
 * returned `{}` on every turn and codex kept its own default compaction prompt.
 * The row's own note names the state — GATED, not held.
 *
 * Widening it is a decision rather than a rename, which is why the record it now
 * reads writes one arm per runtime with its reason. The descriptors are
 * instruction and memory bodies the host composed ONCE with `@path` expansion,
 * the block-HTML-comment strip and the index caps applied by their existing
 * owner; handing them to a runtime says that runtime's sessions get the same
 * composed instruction context Pi's do.
 *
 * ## What this file pins, and why the last part is not redundant
 *
 * The first two describes are the decision and its single reader. The third is
 * P6.54's two filters, re-measured against the widened path rather than assumed
 * from the composer's own suite: `agent-instruction` resources only, and nothing
 * carrying an `mcp:` provenance. They matter more on codex than on Pi because
 * codex compacts SERVER-SIDE — a connected server steering what survives
 * compaction would do so where we cannot see the result at all.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_PROVIDERS } from '@nessy-agent/shared/agent/backend/runtime-vocabulary'
import { materializePiContextResources } from '@nessy-agent/shared/agent/pi-harness/context-resource'
import { composeProjectCompactSteering } from '@nessy-agent/shared/prompts/compaction'
import {
  COMPOSED_INSTRUCTION_CONTEXT_SUPPORT,
  runtimeReadsComposedInstructionContext,
} from '../SessionManager.ts'

const SESSION_MANAGER_SOURCE = join(import.meta.dir, '..', 'SessionManager.ts')

describe('P2.451 — which runtimes are handed the composed instruction context', () => {
  test('codex is admitted, and each other arm keeps the answer it had', () => {
    expect(runtimeReadsComposedInstructionContext('pi')).toBe(true)
    // THE ROW. `false` here is the whole defect P2.436 left behind.
    expect(runtimeReadsComposedInstructionContext('codex-runtime')).toBe(true)
    // Not widened, and deliberately: `claude-agent.ts` never names
    // `piContextResources`, so materializing would hash and read every
    // instruction and memory file for a value with no reader. An absent
    // MECHANISM, not an absent decision.
    expect(runtimeReadsComposedInstructionContext('anthropic')).toBe(false)
    expect(runtimeReadsComposedInstructionContext('nestor-cloud-agent')).toBe(false)
  })

  test('the record is TOTAL over the runtime vocabulary, not a subset', () => {
    // P2.283's property. A `Set` literal is happy with any subset, so a fifth
    // runtime would silently join the `false` side with no build error; a record
    // makes its answer a compile error until someone writes it. This assertion is
    // the runtime half of the same guarantee.
    expect(Object.keys(COMPOSED_INSTRUCTION_CONTEXT_SUPPORT).sort())
      .toEqual([...AGENT_PROVIDERS].sort())
  })
})

describe('P2.451 — the gate site reads the record', () => {
  const source = readFileSync(SESSION_MANAGER_SOURCE, 'utf8')

  test('the materializer is called behind the shared predicate, not a provider chain', () => {
    // Q7's block, one gate over, says why: two independent conditions for one
    // question drift, and always in the direction that hurts. A reader that went
    // back to `provider === 'pi'` here would re-close the gate while every
    // assertion above still passed.
    expect(source).toContain('runtimeReadsComposedInstructionContext(provider)\n        ? await materializePiContextResources({')
    expect(source).not.toContain("const piContextResources = provider === 'pi'")
  })

  test('and still fetches no server-controlled inventory', () => {
    // The second of P6.54's filters, held structurally at this call site: with
    // `mcpResources: []` no `mcp:` descriptor is produced at all, so widening the
    // provider gate cannot open an MCP channel into compaction steering.
    const gate = source.slice(source.indexOf('runtimeReadsComposedInstructionContext(provider)'))
    expect(gate.slice(0, 600)).toContain('mcpResources: [],')
  })
})

describe("P2.451 — P6.54's two filters survive the widening", () => {
  const layer = (key: string) => ({
    key,
    resource: { source: 'project', scope: { kind: 'project' }, resourceId: key, absolutePath: `/x/${key}`, revision: '1', contentHash: 'a'.repeat(64) },
  })

  async function steeringFor(input: { instruction: string; memory: string; mcp?: unknown }) {
    const bodies: Record<string, string> = {
      'AGENTS.md': input.instruction,
      'memory.md': input.memory,
    }
    const descriptors = await materializePiContextResources({
      view: {
        generation: 'gen-1',
        promptLayers: [layer('AGENTS.md')],
        memory: [layer('memory.md')],
        skills: [],
      } as never,
      materializer: {
        assertActive() {},
        readText: async (resource: { resourceId: string }) => bodies[resource.resourceId] ?? '',
      } as never,
      mcpResources: input.mcp
        ? [{ sourceSlug: 'some-server', kind: 'prompt', value: input.mcp }]
        : [],
    })
    return { descriptors, steering: composeProjectCompactSteering(descriptors) }
  }

  test('an instruction file steers, and a memory file carrying the same heading does not', async () => {
    const { descriptors, steering } = await steeringFor({
      instruction: '# Project\n\n## Compact Instructions\n\nKEEP-THE-INSTRUCTION-BODY\n',
      memory: '# Notes\n\n## Compact Instructions\n\nKEEP-THE-MEMORY-BODY\n',
    })
    // Precondition: BOTH bodies really were materialized, so the absence below is
    // the filter and not an empty input.
    expect(descriptors.map(d => d.kind).sort()).toEqual(['agent-instruction', 'context'])
    expect(steering).toContain('KEEP-THE-INSTRUCTION-BODY')
    expect(steering).not.toContain('KEEP-THE-MEMORY-BODY')
  })

  test('an mcp: provenance is dropped even when the descriptor carries the section', async () => {
    const { descriptors, steering } = await steeringFor({
      instruction: '## Compact Instructions\n\nKEEP-THE-INSTRUCTION-BODY\n',
      memory: 'nothing here\n',
      mcp: '## Compact Instructions\n\nKEEP-THE-SERVER-BODY\n',
    })
    // Precondition again: an `mcp:` descriptor was produced on this call.
    expect(descriptors.some(d => d.provenance.startsWith('mcp:'))).toBe(true)
    expect(steering).toContain('KEEP-THE-INSTRUCTION-BODY')
    expect(steering).not.toContain('KEEP-THE-SERVER-BODY')
  })
})

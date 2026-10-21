import { expect, test } from 'bun:test'
import {
  PI_COMPACTION_CUSTOM_INSTRUCTIONS_MAX,
  composePiCompactionInstructions,
  composePiHarnessPrompt,
} from './prompt-composer.ts'
import { getSystemPrompt } from '../../prompts/system.ts'
import { getHarnessToolDescriptor, getPiToolBinding } from './harness-tool-descriptor.ts'

test('derives only advertised Pi guidance and bounded turn references without changing adjacent prompts', () => {
  const adjacentPrompt = getSystemPrompt('Pinned preferences', undefined, '/workspace', '/workspace', undefined, 'Claude Code')
  const prompt = composePiHarnessPrompt('Nessy identity', {
    deferredMcp: { candidatePiNames: ['mcp__hidden__tool'] },
    tools: [
      { binding: { piName: 'lsp' }, descriptor: { effect: 'read', sandboxProfile: 'workspace' }, promptSnippet: 'Navigate code.', promptGuidelines: ['Use bounded queries.'] },
      { binding: { piName: 'mcp__hidden__tool' }, descriptor: { effect: 'read', sandboxProfile: 'host' } },
    ],
  } as any, {
    taskIds: ['task-1'], capabilityRefs: ['skill:a@g1'], permissionRefs: ['permission:q1'], resourceRefs: ['mcp:a@g1'],
  })
  // C3: the contract line carries only what the tool SCHEMA does not already
  // say. `promptSnippet` was the description truncated to 200 chars — the model
  // has it in the schema — and `Effect: …` repeated the parenthetical's own
  // first field, a duplicate inside one line.
  expect(prompt).toContain('lsp (read, workspace)')
  expect(prompt).not.toContain('Navigate code.')
  expect(prompt).not.toContain('Use bounded queries.')
  // A descriptor missing `scheduling` must OMIT it, never render the literal
  // string `undefined` into the model's prompt.
  expect(prompt).not.toContain('undefined')
  expect(prompt).toContain('"resourceRefs":["mcp:a@g1"]')
  expect(prompt).not.toContain('mcp__hidden__tool')
  expect(getSystemPrompt('Pinned preferences', undefined, '/workspace', '/workspace', undefined, 'Claude Code')).toBe(adjacentPrompt)
  const compact = composePiCompactionInstructions(undefined, {
    taskIds: Array.from({ length: 70 }, (_, index) => `t${index}`),
    pendingAskUserRequestId: 'q1', capabilityRefs: ['source:a@g1'], permissionRefs: ['permission:q1'], resourceRefs: ['mcp:a@g1'],
  })
  // K1: compaction instructions always lead with the context-checkpoint handoff
  // prompt, then layer the bounded durable references.
  expect(compact.startsWith('You are performing a CONTEXT CHECKPOINT COMPACTION.')).toBe(true)
  expect(compact).toContain('prior-model handoff checkpoint')
  expect(compact).toContain('"pendingAskUserRequestId":"q1"')
  expect(compact).not.toContain('t69')
  expect(compact).toContain('do not replay actions or promises')
})

/**
 * P3.367 · the durable-reference block used to print `agent:`-prefixed strings
 * inside `resourceRefs`, in the LIVE system prompt on every turn, and the model
 * dispatched them.
 *
 * Both arms matter. The POSITIVE one is that the identifiers still cross — they
 * are durable references and losing them was never the fix. The NEGATIVE one is
 * that they no longer sit in a list whose name says "resource": the field names
 * them opaque, and one sentence beside the value says what they are not.
 */
test('agent definition refs cross as opaque identifiers, never inside resourceRefs', () => {
  const agentRef = 'agent:plugin://tracker#agent.reviewer@workspace:ws-1:@g1:9f8e7d'
  const prompt = composePiHarnessPrompt('Nessy identity', {
    deferredMcp: { candidatePiNames: [] },
    tools: [],
  } as any, {
    taskIds: [],
    capabilityRefs: ['skill::user::-::-::::scout@g1'],
    permissionRefs: [],
    resourceRefs: ['cap-instruction-AGENTS_md-1a2b3c4d-aabbccddeeff:instruction::user::-::-::::AGENTS.md@g1'],
    agentDefinitionRefs: [agentRef],
  })
  // The identifier still crosses…
  expect(prompt).toContain(agentRef)
  // …under a name that says what it is, and NOT inside the resource list. The
  // second assertion is the regression: the old producer concatenated it there.
  expect(prompt).toContain(`"opaqueAgentDefinitionIds":[${JSON.stringify(agentRef)}]`)
  expect(prompt).not.toContain(`"resourceRefs":[${JSON.stringify(agentRef)}`)
  expect(prompt).toContain('never pass one as a subagent type')

  // A session with no subagent definitions pays nothing: neither the key nor
  // the sentence appears, so the standing prompt is byte-identical to before.
  const without = composePiHarnessPrompt('Nessy identity', {
    deferredMcp: { candidatePiNames: [] },
    tools: [],
  } as any, {
    taskIds: [], capabilityRefs: [], permissionRefs: [], resourceRefs: [],
  })
  expect(without).not.toContain('opaqueAgentDefinitionIds')
  expect(without).not.toContain('never pass one as a subagent type')
  // Positive control that the block itself is present in the no-agents case,
  // so the two absences above are not an absent block read as a pass.
  expect(without).toContain('do not replay actions or promises')
})

test('caps explicit /compact custom instructions with a truncation marker (bounded like references)', () => {
  const short = 'Focus on the auth refactor'
  expect(composePiCompactionInstructions(short, undefined)).toContain(short)

  const oversized = 'x'.repeat(PI_COMPACTION_CUSTOM_INSTRUCTIONS_MAX + 5000)
  const capped = composePiCompactionInstructions(oversized, undefined)
  // The handoff prompt still leads; the runaway paste cannot crowd it out.
  expect(capped.startsWith('You are performing a CONTEXT CHECKPOINT COMPACTION.')).toBe(true)
  // The custom-instructions segment is bounded to the cap and carries a marker.
  const customSegment = capped.slice(capped.indexOf('xxx'))
  expect(customSegment.length).toBe(PI_COMPACTION_CUSTOM_INSTRUCTIONS_MAX)
  expect(customSegment.endsWith('… [truncated]')).toBe(true)
  expect(capped).not.toContain('x'.repeat(PI_COMPACTION_CUSTOM_INSTRUCTIONS_MAX + 1))
})

test('advertises the 4 plugin management tools via descriptor-derived assembly only (no hand-maintained manual)', () => {
  const pluginIds = ['plugin_plan_install', 'plugin_install', 'plugin_status', 'plugin_manage']
  const tools = pluginIds.map(id => {
    const binding = getPiToolBinding(`mcp__session__${id}`)
    const descriptor = getHarnessToolDescriptor(id)
    return { binding, descriptor, promptSnippet: `Registered tool ${id}.` }
  })
  const prompt = composePiHarnessPrompt('Nessy identity', {
    deferredMcp: { candidatePiNames: [] },
    tools,
  } as any)

  for (const id of pluginIds) {
    // The row's safety gate: the block still NAMES every resident tool.
    expect(prompt).toContain(`mcp__session__${id}`)
    // And no longer restates its description — that is the saving.
    expect(prompt).not.toContain(`Registered tool ${id}.`)
  }
  // Composer output is entirely derived from manifest.tools (descriptor + binding) —
  // proves there is no separate hand-maintained plugin feature manual to keep in sync.
  // `scheduling` now rides in the parenthetical rather than as prose. It is
  // the one fact in the old guidance block that appears nowhere else, so
  // dropping it with the rest would have been a silent loss.
  expect(prompt).toContain('mcp__session__plugin_install (externalMutation, host, serialByScope)')
  expect(prompt).toContain('mcp__session__plugin_status (read, host, parallel)')
})

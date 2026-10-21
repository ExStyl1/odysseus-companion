import { describe, expect, it } from 'bun:test'
import { computeSkillInvocationDigest, type SkillInvocationRecord } from '../../capabilities/runtime-skill-content.ts'
import { activateCapabilityCatalogEntries, createCapabilityCatalogV1 } from './capability-catalog.ts'
import {
  MAX_CONTINUATION_CAPABILITIES,
  composeContinuationEnvelopePrompt,
  createContinuationEnvelopeV1,
  revalidateContinuationEnvelopeV1,
} from './continuation-envelope.ts'

const hash = (value: string) => value.repeat(64).slice(0, 64)
const skillSnapshot = (body = 'Review the requested change.'): SkillInvocationRecord => {
  const record = {
    key: 'skill://review', name: 'review', sourceDigest: hash('a'), generation: 'generation-1', invokedAt: 1, body,
    supportingResources: [], restrictions: {},
    states: { available: true as const, selected: true as const, resourceLoaded: false, grantApplied: true as const },
  }
  return { ...record, invocationDigest: computeSkillInvocationDigest(record) }
}
const skillReference = () => ({ id: 'skill://review', digest: hash('a'), snapshot: skillSnapshot() })
const catalog = createCapabilityCatalogV1('generation-1', [{
  semanticId: 'mcp__gitlab__list_repositories', displayName: 'List repositories', modelName: 'mcp__gitlab__list_repositories',
  kind: 'mcp', description: 'List GitLab repositories', inputSummary: 'owner: string', effect: 'external-read', risk: 'low', source: 'mcp:gitlab',
}])
const [toolLease] = activateCapabilityCatalogEntries(catalog, ['mcp__gitlab__list_repositories'])

describe('ContinuationEnvelopeV1', () => {
  it('keeps the same bounded durable references for manual, threshold and overflow compaction', () => {
    const build = () => createContinuationEnvelopeV1({
      capabilityGeneration: 'generation-1',
      activatedTools: [toolLease!],
      invokedSkills: [skillReference()],
      taskIds: ['task-1'], plan: { revision: 2, status: 'approved' }, goal: { id: 'goal-1', revision: 3 },
      pendingInteraction: { kind: 'ask_user', id: 'ask-1' },
      childIds: ['child-1'], processIds: ['process-1'], workflowIds: ['workflow-1'],
      permissionReceiptIds: ['permission-1'], resourceReceiptIds: ['resource-1'],
    })
    expect(build()).toEqual(build())
    expect(JSON.stringify(build())).not.toContain('inputSchema')
    const prompt = composeContinuationEnvelopePrompt(build())
    expect(prompt).toContain('never replay pending input')
    expect(prompt).not.toContain('Review the requested change.')
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(8192)
  })

  it('revalidates leases after compaction and reports revoked references without resurrection', () => {
    const envelope = createContinuationEnvelopeV1({
      capabilityGeneration: 'generation-1', activatedTools: [toolLease!],
      invokedSkills: [skillReference()],
      pendingInteraction: { kind: 'permission', id: 'pending-1' },
    })
    const restored = revalidateContinuationEnvelopeV1({
      envelope, capabilityGeneration: 'generation-1',
      availableToolDigests: new Map([[toolLease!.semanticId, toolLease!.digest]]),
      availableSkillDigests: new Map([['skill://review', hash('b')]]),
    })
    expect(restored.envelope.activatedTools).toHaveLength(1)
    expect(restored.envelope.invokedSkills).toEqual([])
    expect(restored.envelope.pendingInteraction).toEqual({ kind: 'permission', id: 'pending-1' })
    expect(restored.revoked).toEqual([{ kind: 'skill', id: 'skill://review', reason: 'digest-changed' }])

    const stale = revalidateContinuationEnvelopeV1({
      envelope, capabilityGeneration: 'generation-2', availableToolDigests: new Map(), availableSkillDigests: new Map(),
    })
    expect(stale.envelope.activatedTools).toEqual([])
    expect(stale.envelope.invokedSkills).toEqual([])
    expect(stale.revoked.map(value => value.reason)).toEqual(['generation-changed', 'generation-changed'])
  })

  it('caps references and rejects secrets, absolute paths and invalid digests', () => {
    expect(createContinuationEnvelopeV1({
      capabilityGeneration: 'generation-1',
      taskIds: Array.from({ length: 100 }, (_, index) => `task-${index}`),
    }).taskIds).toHaveLength(64)
    expect(() => createContinuationEnvelopeV1({ capabilityGeneration: 'generation-1', processIds: ['/tmp/process'] })).toThrow('path')
    expect(() => createContinuationEnvelopeV1({ capabilityGeneration: 'generation-1', permissionReceiptIds: ['sk-secret-token'] })).toThrow('secret')
    expect(() => createContinuationEnvelopeV1({ capabilityGeneration: 'generation-1', invokedSkills: [{ id: 'skill', digest: 'bad' }] as any })).toThrow('digest')
    expect(MAX_CONTINUATION_CAPABILITIES).toBe(64)
  })
})

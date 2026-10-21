import { describe, expect, test } from 'bun:test'

import { getHarnessToolDescriptor, PI_TOOL_BINDINGS } from './harness-tool-descriptor.ts'
import {
  AGENT_HARNESS_PRIORITY_WEIGHTS,
  createAgentHarnessCapabilities,
  scoreAgentHarnessCapabilities,
  validateAgentHarnessBehaviorCorpus,
  validateAgentHarnessCapabilities,
  type AgentHarnessBehaviorCase,
} from './agent-harness-capabilities.ts'

const cases: AgentHarnessBehaviorCase[] = [
  {
    id: 'implemented-p0',
    priority: 'P0',
    weight: 5,
    targetObservable: 'one implemented contract',
    currentStatus: 'implemented',
    owner: 'Harness contract',
    targetPhase: 'X1',
    sourceAnchors: ['repo://implemented'],
    observable: { outcomes: ['implemented'] },
  },
  {
    id: 'partial-p1',
    priority: 'P1',
    weight: 3,
    targetObservable: 'one partial contract',
    currentStatus: 'partial',
    owner: 'Harness contract',
    targetPhase: 'X3',
    sourceAnchors: ['repo://partial'],
    observable: { sequence: ['start', 'finish'] },
  },
  {
    id: 'accepted-p2',
    priority: 'P2',
    weight: 1,
    targetObservable: 'one accepted difference',
    currentStatus: 'accepted-difference',
    owner: 'Harness contract',
    targetPhase: 'X9',
    sourceAnchors: ['repo://accepted'],
    observable: { outcomes: ['provider-specific boundary retained'] },
  },
]

describe('AgentHarnessCapabilities', () => {
  test('derives tool semantics from the canonical H2 descriptors and bindings', () => {
    const contract = createAgentHarnessCapabilities(cases)
    const uniqueBindings = new Map(PI_TOOL_BINDINGS.map(binding => [binding.bindingName, binding]))

    expect(contract.contractVersion).toBe(2)
    expect(contract.toolSemantics).toHaveLength(uniqueBindings.size)
    for (const tool of contract.toolSemantics) {
      expect(tool.binding).toBe(uniqueBindings.get(tool.binding.bindingName)!)
      expect(tool.descriptor).toBe(getHarnessToolDescriptor(tool.binding.descriptorId))
    }
    expect(() => validateAgentHarnessCapabilities(contract)).not.toThrow()

    const duplicateOneMissingAnother = {
      ...contract,
      toolSemantics: [...contract.toolSemantics],
    }
    duplicateOneMissingAnother.toolSemantics.splice(1, 1, duplicateOneMissingAnother.toolSemantics[0]!)
    expect(() => validateAgentHarnessCapabilities(duplicateOneMissingAnother))
      .toThrow('Duplicate canonical tool binding')
  })

  test('scores current status without counting planned gaps as implemented parity', () => {
    const score = scoreAgentHarnessCapabilities(createAgentHarnessCapabilities(cases))

    expect(score).toEqual({
      totals: { implemented: 1, partial: 1, missing: 0, blocked: 0, 'accepted-difference': 1 },
      weightedTotal: 9,
      implementedWeight: 5,
      acceptedDifferenceWeight: 1,
      implementedPercentage: 55.56,
      acceptedContractPercentage: 66.67,
    })
  })

  test('rejects malformed scorecards and corpus records deterministically', () => {
    const validCorpus = {
      schemaVersion: 1,
      capabilityContractVersion: 2,
      priorityWeights: AGENT_HARNESS_PRIORITY_WEIGHTS,
      cases,
      hookInventory: ['SessionStart'],
      providerFixtures: [{
        id: 'provider-fixture',
        dialect: 'pi-qwen',
        sanitizedInput: { type: 'turn_start' },
        expectedOutcome: { sequence: ['turn_started'] },
        sourceAnchors: ['repo://provider'],
      }],
    }
    expect(() => validateAgentHarnessBehaviorCorpus(validCorpus)).not.toThrow()

    const mutations: Array<[string, (value: any) => void]> = [
      ['unknown schema version', value => { value.schemaVersion = 2 }],
      ['duplicate IDs', value => { value.cases.push(structuredClone(value.cases[0])) }],
      ['missing owner', value => { delete value.cases[0].owner }],
      ['missing weight', value => { delete value.cases[0].weight }],
      ['missing source anchor', value => { value.cases[0].sourceAnchors = [] }],
      ['transient field', value => { value.providerFixtures[0].sanitizedInput.requestId = 'random' }],
      ['proprietary field', value => { value.providerFixtures[0].sanitizedInput.privateTranscript = 'secret' }],
    ]
    for (const [name, mutate] of mutations) {
      const value = structuredClone(validCorpus)
      mutate(value)
      expect(() => validateAgentHarnessBehaviorCorpus(value), name).toThrow()
    }
  })
})

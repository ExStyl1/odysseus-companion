import {
  getHarnessToolDescriptor,
  PI_TOOL_BINDINGS,
  type HarnessToolDescriptor,
  type PiToolBinding,
} from './harness-tool-descriptor.ts'

export const AGENT_HARNESS_CAPABILITIES_VERSION = 2 as const
export const AGENT_HARNESS_BEHAVIOR_CORPUS_VERSION = 1 as const
export const AGENT_HARNESS_PRIORITY_WEIGHTS = Object.freeze({ P0: 5, P1: 3, P2: 1 } as const)

export type AgentHarnessPriority = keyof typeof AGENT_HARNESS_PRIORITY_WEIGHTS
export type AgentHarnessImplementationStatus =
  | 'implemented'
  | 'partial'
  | 'missing'
  | 'blocked'
  | 'accepted-difference'

export interface AgentHarnessBehaviorCase {
  id: string
  priority: AgentHarnessPriority
  weight: number
  targetObservable: string
  currentStatus: AgentHarnessImplementationStatus
  owner: string
  targetPhase: string
  sourceAnchors: readonly string[]
  observable: {
    sequence?: readonly string[]
    outcomes?: readonly string[]
  }
}

export interface AgentHarnessProviderFixture {
  id: string
  dialect: 'pi-qwen' | 'nestor-a2a'
  sanitizedInput: Record<string, unknown>
  expectedOutcome: Record<string, unknown>
  sourceAnchors: readonly string[]
}

export interface AgentHarnessBehaviorCorpusV1 {
  schemaVersion: typeof AGENT_HARNESS_BEHAVIOR_CORPUS_VERSION
  capabilityContractVersion: typeof AGENT_HARNESS_CAPABILITIES_VERSION
  priorityWeights: typeof AGENT_HARNESS_PRIORITY_WEIGHTS
  cases: readonly AgentHarnessBehaviorCase[]
  hookInventory: readonly string[]
  providerFixtures: readonly AgentHarnessProviderFixture[]
  expectedScore?: AgentHarnessCapabilityScore
}

export interface AgentHarnessCapabilitiesV2 {
  contractVersion: typeof AGENT_HARNESS_CAPABILITIES_VERSION
  cases: readonly AgentHarnessBehaviorCase[]
  toolSemantics: readonly {
    binding: PiToolBinding
    descriptor: HarnessToolDescriptor
  }[]
}

export interface AgentHarnessCapabilityScore {
  totals: Record<AgentHarnessImplementationStatus, number>
  weightedTotal: number
  implementedWeight: number
  acceptedDifferenceWeight: number
  implementedPercentage: number
  acceptedContractPercentage: number
}

const STATUSES: readonly AgentHarnessImplementationStatus[] = [
  'implemented', 'partial', 'missing', 'blocked', 'accepted-difference',
]
const PRIORITIES = Object.keys(AGENT_HARNESS_PRIORITY_WEIGHTS) as AgentHarnessPriority[]
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TARGET_PHASE = /^X(?:0|[1-9]|10|11)(?:[AB])?(?:\/X(?:0|[1-9]|10|11)(?:[AB])?)*$/
const FORBIDDEN_DATA_KEYS = new Set([
  'credential', 'credentials', 'privatetranscript', 'privateprompt', 'requestid',
  'sessionid', 'timestamp', 'toolcallid', 'liveresponse',
])

export function createAgentHarnessCapabilities(
  cases: readonly AgentHarnessBehaviorCase[],
): AgentHarnessCapabilitiesV2 {
  const uniqueBindings = new Map(PI_TOOL_BINDINGS.map(binding => [binding.bindingName, binding]))
  const contract: AgentHarnessCapabilitiesV2 = {
    contractVersion: AGENT_HARNESS_CAPABILITIES_VERSION,
    cases,
    toolSemantics: [...uniqueBindings.values()].map(binding => ({
      binding,
      descriptor: getHarnessToolDescriptor(binding.descriptorId),
    })),
  }
  validateAgentHarnessCapabilities(contract)
  return Object.freeze(contract)
}

export function validateAgentHarnessCapabilities(value: unknown): asserts value is AgentHarnessCapabilitiesV2 {
  const contract = record(value, 'AgentHarnessCapabilities')
  if (contract.contractVersion !== AGENT_HARNESS_CAPABILITIES_VERSION) {
    throw new Error(`Unknown AgentHarnessCapabilities version: ${String(contract.contractVersion)}`)
  }
  const cases = array(contract.cases, 'AgentHarnessCapabilities.cases')
  validateCases(cases)
  const tools = array(contract.toolSemantics, 'AgentHarnessCapabilities.toolSemantics')
  const canonical = new Map(PI_TOOL_BINDINGS.map(binding => [binding.bindingName, binding]))
  const seen = new Set<string>()
  const checked: Array<{ tool: Record<string, unknown>; expected: PiToolBinding }> = []
  for (const value of tools) {
    const tool = record(value, 'AgentHarnessCapabilities.toolSemantics[]')
    const binding = record(tool.binding, 'AgentHarnessCapabilities.toolSemantics[].binding')
    const bindingName = text(binding.bindingName, 'AgentHarnessCapabilities.toolSemantics[].bindingName')
    const expected = canonical.get(bindingName)
    if (!expected) throw new Error(`Unknown canonical tool binding: ${bindingName}`)
    if (seen.has(bindingName)) throw new Error(`Duplicate canonical tool binding: ${bindingName}`)
    seen.add(bindingName)
    checked.push({ tool, expected })
  }
  for (const bindingName of canonical.keys()) {
    if (!seen.has(bindingName)) throw new Error(`Missing canonical tool binding: ${bindingName}`)
  }
  for (const { tool, expected } of checked) {
    if (tool.binding !== expected || tool.descriptor !== getHarnessToolDescriptor(expected.descriptorId)) {
      throw new Error('AgentHarnessCapabilities must derive tool semantics from canonical H2 owners')
    }
  }
}

export function validateAgentHarnessBehaviorCorpus(
  value: unknown,
): asserts value is AgentHarnessBehaviorCorpusV1 {
  rejectForbiddenData(value)
  const corpus = record(value, 'AgentHarnessBehaviorCorpus')
  if (corpus.schemaVersion !== AGENT_HARNESS_BEHAVIOR_CORPUS_VERSION) {
    throw new Error(`Unknown behavior corpus version: ${String(corpus.schemaVersion)}`)
  }
  if (corpus.capabilityContractVersion !== AGENT_HARNESS_CAPABILITIES_VERSION) {
    throw new Error(`Unknown capability contract version: ${String(corpus.capabilityContractVersion)}`)
  }
  const weights = record(corpus.priorityWeights, 'priorityWeights')
  for (const priority of PRIORITIES) {
    if (weights[priority] !== AGENT_HARNESS_PRIORITY_WEIGHTS[priority]) {
      throw new Error(`Invalid ${priority} weight`)
    }
  }
  if (Object.keys(weights).length !== PRIORITIES.length) throw new Error('Unknown priority weight')

  const cases = array(corpus.cases, 'cases')
  validateCases(cases)
  const ids = new Set(cases.map(value => record(value, 'cases[]').id as string))

  const hooks = stringArray(corpus.hookInventory, 'hookInventory')
  if (hooks.length === 0 || new Set(hooks).size !== hooks.length) {
    throw new Error('Hook inventory must be non-empty and unique')
  }

  const fixtures = array(corpus.providerFixtures, 'providerFixtures')
  if (fixtures.length === 0) throw new Error('Provider fixtures are required')
  for (const value of fixtures) {
    const fixture = record(value, 'providerFixtures[]')
    const id = stableId(fixture.id, 'providerFixtures[].id')
    if (ids.has(id)) throw new Error(`Duplicate stable ID: ${id}`)
    ids.add(id)
    if (fixture.dialect !== 'pi-qwen' && fixture.dialect !== 'nestor-a2a') {
      throw new Error(`Unknown provider fixture dialect: ${String(fixture.dialect)}`)
    }
    record(fixture.sanitizedInput, `${id}.sanitizedInput`)
    record(fixture.expectedOutcome, `${id}.expectedOutcome`)
    nonEmptyStrings(fixture.sourceAnchors, `${id}.sourceAnchors`)
  }

  if (corpus.expectedScore !== undefined) {
    const actual = scoreAgentHarnessCapabilities(createAgentHarnessCapabilities(cases as AgentHarnessBehaviorCase[]))
    if (JSON.stringify(actual) !== JSON.stringify(corpus.expectedScore)) {
      throw new Error('Behavior corpus expected score mismatch')
    }
  }
}

export function scoreAgentHarnessCapabilities(
  contract: AgentHarnessCapabilitiesV2,
): AgentHarnessCapabilityScore {
  validateAgentHarnessCapabilities(contract)
  const totals: Record<AgentHarnessImplementationStatus, number> = {
    implemented: 0,
    partial: 0,
    missing: 0,
    blocked: 0,
    'accepted-difference': 0,
  }
  let weightedTotal = 0
  let implementedWeight = 0
  let acceptedDifferenceWeight = 0
  for (const capability of contract.cases) {
    totals[capability.currentStatus] += 1
    weightedTotal += capability.weight
    if (capability.currentStatus === 'implemented') implementedWeight += capability.weight
    if (capability.currentStatus === 'accepted-difference') acceptedDifferenceWeight += capability.weight
  }
  return {
    totals,
    weightedTotal,
    implementedWeight,
    acceptedDifferenceWeight,
    implementedPercentage: percentage(implementedWeight, weightedTotal),
    acceptedContractPercentage: percentage(implementedWeight + acceptedDifferenceWeight, weightedTotal),
  }
}

function validateCases(values: unknown[]): void {
  if (values.length === 0) throw new Error('Behavior cases are required')
  const ids = new Set<string>()
  for (const value of values) {
    const capability = record(value, 'cases[]')
    const id = stableId(capability.id, 'cases[].id')
    if (ids.has(id)) throw new Error(`Duplicate stable ID: ${id}`)
    ids.add(id)
    if (!PRIORITIES.includes(capability.priority as AgentHarnessPriority)) {
      throw new Error(`Unknown priority for ${id}`)
    }
    const expectedWeight = AGENT_HARNESS_PRIORITY_WEIGHTS[capability.priority as AgentHarnessPriority]
    if (capability.weight !== expectedWeight) throw new Error(`Invalid weight for ${id}`)
    text(capability.targetObservable, `${id}.targetObservable`)
    if (!STATUSES.includes(capability.currentStatus as AgentHarnessImplementationStatus)) {
      throw new Error(`Unknown current status for ${id}`)
    }
    text(capability.owner, `${id}.owner`)
    const targetPhase = text(capability.targetPhase, `${id}.targetPhase`)
    if (!TARGET_PHASE.test(targetPhase)) throw new Error(`Invalid target phase for ${id}`)
    nonEmptyStrings(capability.sourceAnchors, `${id}.sourceAnchors`)
    const observable = record(capability.observable, `${id}.observable`)
    const sequence = observable.sequence === undefined ? [] : nonEmptyStrings(observable.sequence, `${id}.sequence`)
    const outcomes = observable.outcomes === undefined ? [] : nonEmptyStrings(observable.outcomes, `${id}.outcomes`)
    if (sequence.length === 0 && outcomes.length === 0) throw new Error(`Missing observable contract for ${id}`)
  }
}

function rejectForbiddenData(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenData(item)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_DATA_KEYS.has(key.replace(/[^a-z]/gi, '').toLowerCase())) {
      throw new Error(`Transient or proprietary field is forbidden: ${key}`)
    }
    rejectForbiddenData(item)
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value
}

function stableId(value: unknown, name: string): string {
  const id = text(value, name)
  if (!STABLE_ID.test(id)) throw new Error(`${name} must be a stable kebab-case ID`)
  return id
}

function stringArray(value: unknown, name: string): string[] {
  const values = array(value, name)
  return values.map((item, index) => text(item, `${name}[${index}]`))
}

function nonEmptyStrings(value: unknown, name: string): string[] {
  const values = stringArray(value, name)
  if (values.length === 0) throw new Error(`${name} must not be empty`)
  return values
}

function percentage(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 10_000) / 100
}

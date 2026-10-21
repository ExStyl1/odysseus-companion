import type { CapabilityActivationLeaseV1 } from './capability-catalog.ts'
import {
  MAX_REATTACHED_SKILL_PERSISTENCE_BYTES,
  validateSkillInvocationSnapshot,
  type SkillInvocationRecord,
} from '../../capabilities/runtime-skill-content.ts'

export const CONTINUATION_ENVELOPE_VERSION = 1 as const
export const MAX_CONTINUATION_CAPABILITIES = 64
export const MAX_CONTINUATION_SKILLS = 64
export const MAX_CONTINUATION_TASKS = 64
export const MAX_CONTINUATION_RUNTIME_REFS = 64
export const MAX_CONTINUATION_RECEIPTS = 64
export const MAX_CONTINUATION_BYTES = MAX_REATTACHED_SKILL_PERSISTENCE_BYTES

export interface ContinuationResourceReferenceV1 {
  id: string
  digest: string
  snapshot: SkillInvocationRecord
}

export interface ContinuationEnvelopeV1 {
  schemaVersion: typeof CONTINUATION_ENVELOPE_VERSION
  capabilityGeneration: string
  activatedTools: readonly CapabilityActivationLeaseV1[]
  invokedSkills: readonly ContinuationResourceReferenceV1[]
  taskIds: readonly string[]
  plan?: { revision: number; status: string }
  goal?: { id: string; revision?: number }
  pendingInteraction?: { kind: 'ask_user' | 'permission' | 'elicitation'; id: string }
  childIds: readonly string[]
  processIds: readonly string[]
  workflowIds: readonly string[]
  permissionReceiptIds: readonly string[]
  resourceReceiptIds: readonly string[]
}

export interface ContinuationEnvelopeInputV1 {
  capabilityGeneration: string
  activatedTools?: readonly CapabilityActivationLeaseV1[]
  invokedSkills?: readonly ContinuationResourceReferenceV1[]
  taskIds?: readonly string[]
  plan?: ContinuationEnvelopeV1['plan']
  goal?: ContinuationEnvelopeV1['goal']
  pendingInteraction?: ContinuationEnvelopeV1['pendingInteraction']
  childIds?: readonly string[]
  processIds?: readonly string[]
  workflowIds?: readonly string[]
  permissionReceiptIds?: readonly string[]
  resourceReceiptIds?: readonly string[]
}

/** Runtime-only state delivered to the server-owned continuation record. */
export interface PiContinuationRuntimeStateV1 {
  capabilityGeneration: string
  activatedTools: readonly CapabilityActivationLeaseV1[]
  invokedSkills: readonly ContinuationResourceReferenceV1[]
}

export interface ContinuationRevocationV1 {
  kind: 'tool' | 'skill'
  id: string
  reason: 'generation-changed' | 'unavailable' | 'digest-changed'
}

const SECRET_VALUE = /^(?:bearer\s+|sk-[a-z0-9_-]{8,}|gh[opusr]_[a-z0-9]{8,})/i
const ABSOLUTE_PATH = /^(?:\/|[a-z]:[\\/]|\\\\)/i

function referenceText(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid continuation ${field}`)
  }
  if (ABSOLUTE_PATH.test(normalized) || normalized.includes('../') || normalized.includes('..\\')) {
    throw new Error(`Continuation ${field} must not contain an absolute or escaping path`)
  }
  if (SECRET_VALUE.test(normalized)) throw new Error(`Continuation ${field} must not contain a secret`)
  return normalized
}

function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid continuation ${field} digest`)
  return value
}

function uniqueRefs(values: readonly string[] | undefined, field: string, max: number): readonly string[] {
  return Object.freeze([...new Set((values ?? []).map(value => referenceText(value, field)))].slice(0, max))
}

function resourceRefs(
  values: readonly ContinuationResourceReferenceV1[] | undefined,
  generation: string,
): readonly ContinuationResourceReferenceV1[] {
  const byId = new Map<string, ContinuationResourceReferenceV1>()
  for (const value of (values ?? []).slice(0, MAX_CONTINUATION_SKILLS)) {
    const id = referenceText(value.id, 'skill id')
    const sourceDigest = digest(value.digest, 'skill')
    const snapshot = validateSkillInvocationSnapshot(value.snapshot, { key: id, sourceDigest, generation })
    byId.set(id, Object.freeze({ id, digest: sourceDigest, snapshot }))
  }
  return Object.freeze([...byId.values()])
}

function activationRefs(values: readonly CapabilityActivationLeaseV1[] | undefined, generation: string): readonly CapabilityActivationLeaseV1[] {
  const byId = new Map<string, CapabilityActivationLeaseV1>()
  for (const value of (values ?? []).slice(0, MAX_CONTINUATION_CAPABILITIES)) {
    const semanticId = referenceText(value.semanticId, 'tool id')
    if (value.schemaVersion !== 1 || value.capabilityGeneration !== generation) {
      throw new Error(`Invalid continuation tool lease: ${semanticId}`)
    }
    byId.set(semanticId, Object.freeze({
      schemaVersion: 1,
      semanticId,
      capabilityGeneration: generation,
      digest: digest(value.digest, 'tool'),
    }))
  }
  return Object.freeze([...byId.values()])
}

function revision(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid continuation ${field} revision`)
  return value
}

export function createContinuationEnvelopeV1(input: ContinuationEnvelopeInputV1): ContinuationEnvelopeV1 {
  const capabilityGeneration = referenceText(input.capabilityGeneration, 'capability generation')
  if (input.pendingInteraction && !['ask_user', 'permission', 'elicitation'].includes(input.pendingInteraction.kind)) {
    throw new Error('Invalid continuation pending interaction kind')
  }
  const envelope: ContinuationEnvelopeV1 = Object.freeze({
    schemaVersion: CONTINUATION_ENVELOPE_VERSION,
    capabilityGeneration,
    activatedTools: activationRefs(input.activatedTools, capabilityGeneration),
    invokedSkills: resourceRefs(input.invokedSkills, capabilityGeneration),
    taskIds: uniqueRefs(input.taskIds, 'task id', MAX_CONTINUATION_TASKS),
    ...(input.plan ? { plan: Object.freeze({ revision: revision(input.plan.revision, 'plan'), status: referenceText(input.plan.status, 'plan status') }) } : {}),
    ...(input.goal ? { goal: Object.freeze({ id: referenceText(input.goal.id, 'goal id'), ...(input.goal.revision === undefined ? {} : { revision: revision(input.goal.revision, 'goal') }) }) } : {}),
    ...(input.pendingInteraction ? { pendingInteraction: Object.freeze({ kind: input.pendingInteraction.kind, id: referenceText(input.pendingInteraction.id, 'pending interaction id') }) } : {}),
    childIds: uniqueRefs(input.childIds, 'child id', MAX_CONTINUATION_RUNTIME_REFS),
    processIds: uniqueRefs(input.processIds, 'process id', MAX_CONTINUATION_RUNTIME_REFS),
    workflowIds: uniqueRefs(input.workflowIds, 'workflow id', MAX_CONTINUATION_RUNTIME_REFS),
    permissionReceiptIds: uniqueRefs(input.permissionReceiptIds, 'permission receipt id', MAX_CONTINUATION_RECEIPTS),
    resourceReceiptIds: uniqueRefs(input.resourceReceiptIds, 'resource receipt id', MAX_CONTINUATION_RECEIPTS),
  })
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_CONTINUATION_BYTES) {
    throw new Error(`Continuation envelope exceeds ${MAX_CONTINUATION_BYTES} bytes`)
  }
  return envelope
}

export function revalidateContinuationEnvelopeV1(input: {
  envelope: ContinuationEnvelopeV1
  capabilityGeneration: string
  availableToolDigests: ReadonlyMap<string, string>
  availableSkillDigests: ReadonlyMap<string, string>
}): { envelope: ContinuationEnvelopeV1; revoked: readonly ContinuationRevocationV1[] } {
  const revoked: ContinuationRevocationV1[] = []
  const generationMatches = input.envelope.capabilityGeneration === input.capabilityGeneration
  const activatedTools = input.envelope.activatedTools.filter(reference => {
    if (!generationMatches) {
      revoked.push({ kind: 'tool', id: reference.semanticId, reason: 'generation-changed' })
      return false
    }
    const current = input.availableToolDigests.get(reference.semanticId)
    if (!current) {
      revoked.push({ kind: 'tool', id: reference.semanticId, reason: 'unavailable' })
      return false
    }
    if (current !== reference.digest) {
      revoked.push({ kind: 'tool', id: reference.semanticId, reason: 'digest-changed' })
      return false
    }
    return true
  })
  const invokedSkills = input.envelope.invokedSkills.filter(reference => {
    if (!generationMatches) {
      revoked.push({ kind: 'skill', id: reference.id, reason: 'generation-changed' })
      return false
    }
    const current = input.availableSkillDigests.get(reference.id)
    if (!current) {
      revoked.push({ kind: 'skill', id: reference.id, reason: 'unavailable' })
      return false
    }
    if (current !== reference.digest) {
      revoked.push({ kind: 'skill', id: reference.id, reason: 'digest-changed' })
      return false
    }
    return true
  })
  return {
    envelope: createContinuationEnvelopeV1({ ...input.envelope, capabilityGeneration: input.capabilityGeneration, activatedTools, invokedSkills }),
    revoked: Object.freeze(revoked),
  }
}

export function composeContinuationEnvelopePrompt(envelope: ContinuationEnvelopeV1, revoked: readonly ContinuationRevocationV1[] = []): string {
  const payload = JSON.stringify({
    ...envelope,
    invokedSkills: envelope.invokedSkills.map(reference => ({
      id: reference.id,
      digest: reference.digest,
      invocationDigest: reference.snapshot.invocationDigest,
    })),
    ...(revoked.length ? { revoked } : {}),
  })
  const prefix = 'Preserve these durable Nessy references only. Revalidate before use; never replay pending input: '
  const marker = '… [truncated]'
  const budget = 8192 - Buffer.byteLength(prefix, 'utf8')
  const source = Buffer.from(payload, 'utf8')
  let bounded = payload
  if (source.length > budget) {
    const markerBytes = Buffer.byteLength(marker, 'utf8')
    let content = source.subarray(0, budget - markerBytes).toString('utf8')
    while (Buffer.byteLength(content, 'utf8') + markerBytes > budget) content = content.slice(0, -1)
    bounded = `${content}${marker}`
  }
  return `${prefix}${bounded}`
}

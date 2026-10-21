import type { PiHarnessExecutionReceiptSummaryV1 } from '@nessy-agent/core/types'
import type { ExecutionObservationEnvelopeV1, SessionKey } from '../../sessions/types.ts'
import type { ToolExecutionReceipt } from './execution-receipt.ts'
import type { PiPermissionReceiptV1 } from './permission-receipt.ts'

export type { ExecutionObservationEnvelopeV1 } from '../../sessions/types.ts'

const MAX_ID = 256
const MAX_CODE = 128
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/
const SAFE_ISOLATION_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/

export type SafeExecutionReceiptInputV1 = Omit<PiHarnessExecutionReceiptSummaryV1, 'sequence'>

export interface PiTelemetryEventV1 {
  schemaVersion: 1
  name: 'session.started' | 'session.settled' | 'tool.completed'
    | 'permission.decided' | 'mcp.completed' | 'hook.completed'
  timestamp: number
  workspaceHash: string
  sessionHash: string
  /**
   * P6.538 · the session's OWN id, in the clear.
   *
   * Present ONLY when an operator has set the documented
   * `OTEL_METRICS_INCLUDE_SESSION_ID` — owner decision 2026-09-05 D13 = option
   * B, identity behind the documented toggles, DEFAULT OFF. Absent is the
   * default and the shipped behaviour: `sessionHash` above stays the anonymous
   * mode and is emitted either way, so a record is never LESS identifiable than
   * it was, and turning the switch on adds a field rather than replacing one.
   *
   * The exporter fills it (`pi-harness/otlp-telemetry.ts`), never a caller: the
   * decision is the host's, made once, in the one place that also stamps the
   * digests.
   */
  sessionId?: string
  outcome?: 'success' | 'error' | 'denied' | 'cancelled'
  durationMs?: number
  semanticId?: string
}

export type PiTelemetryProjection = Pick<PiTelemetryEventV1, 'name' | 'outcome' | 'durationMs' | 'semanticId'>

export interface ExecutionReceiptRingOptions {
  limit?: number
  maxAgeMs?: number
  now?: () => number
  initialEntries?: unknown
}

export class ExecutionReceiptRing {
  private readonly limit: number
  private readonly maxAgeMs: number
  private readonly now: () => number
  private readonly entries: ExecutionObservationEnvelopeV1[] = []
  private nextSequence = 1

  constructor(private readonly session: SessionKey, options: ExecutionReceiptRingOptions = {}) {
    this.limit = options.limit ?? 50
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 50) throw new Error('execution-receipt-limit-invalid')
    if (!Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs < 1) throw new Error('execution-receipt-max-age-invalid')
    const initialEntries = Array.isArray(options.initialEntries)
      ? options.initialEntries.slice(-this.limit)
      : []
    let maxSequence = 0
    const seen = new Set<number>()
    for (const value of initialEntries) {
      try {
        const entry = parseExecutionObservationEnvelope(value, this.session)
        maxSequence = Math.max(maxSequence, entry.receipt.sequence)
        if (!seen.has(entry.receipt.sequence)) {
          seen.add(entry.receipt.sequence)
          this.entries.push(entry)
        }
      } catch {
        // Corrupt or pre-redaction records fail closed without hiding the session.
      }
    }
    this.entries.sort((left, right) => left.receipt.sequence - right.receipt.sequence)
    this.nextSequence = maxSequence + 1
    this.gc(this.now())
  }

  append(value: unknown): PiHarnessExecutionReceiptSummaryV1 {
    const input = parseSafeExecutionReceiptInput(value)
    const observedAt = this.now()
    this.gc(observedAt)
    if (!Number.isSafeInteger(this.nextSequence)) throw new Error('execution-receipt-sequence-exhausted')
    const receipt = Object.freeze({ ...input, sequence: this.nextSequence++ })
    this.entries.push(Object.freeze({
      schemaVersion: 1,
      kind: 'tool_execution',
      session: Object.freeze({ ...this.session }),
      observedAt,
      receipt,
    }))
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    return receipt
  }

  snapshot(): readonly PiHarnessExecutionReceiptSummaryV1[] {
    this.gc(this.now())
    return Object.freeze(this.entries.map(entry => entry.receipt))
  }

  persistedSnapshot(): readonly ExecutionObservationEnvelopeV1[] {
    this.gc(this.now())
    return Object.freeze([...this.entries])
  }

  private gc(now: number): void {
    const cutoff = now - this.maxAgeMs
    while (this.entries[0] && this.entries[0].observedAt < cutoff) this.entries.shift()
  }
}

function parseExecutionObservationEnvelope(value: unknown, owner: SessionKey): ExecutionObservationEnvelopeV1 {
  const input = record(value)
  exact(input, ['schemaVersion', 'kind', 'session', 'observedAt', 'receipt'])
  if (input.schemaVersion !== 1 || input.kind !== 'tool_execution') throw new Error('execution-observation-version-invalid')
  const rawSession = record(input.session)
  exact(rawSession, ['workspaceId', 'sessionId'])
  const session = Object.freeze({ workspaceId: safeId(rawSession.workspaceId), sessionId: safeId(rawSession.sessionId) })
  if (session.workspaceId !== owner.workspaceId || session.sessionId !== owner.sessionId) throw new Error('execution-observation-owner-invalid')
  const rawReceipt = record(input.receipt)
  const { sequence: rawSequence, ...safeInput } = rawReceipt
  const sequence = integer(rawSequence)
  if (sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) throw new Error('execution-receipt-sequence-invalid')
  const receipt = Object.freeze({ ...parseSafeExecutionReceiptInput(safeInput), sequence })
  return Object.freeze({
    schemaVersion: 1,
    kind: 'tool_execution',
    session,
    observedAt: integer(input.observedAt),
    receipt,
  })
}

export function summarizeExecutionReceipt(receipt: ToolExecutionReceipt): SafeExecutionReceiptInputV1 {
  return parseSafeExecutionReceiptInput({
    executionId: receipt.executionId,
    semanticId: receipt.semanticId,
    outcome: receipt.outcome,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    manifestGeneration: receipt.manifestGeneration,
    responseEpoch: receipt.responseEpoch,
    effect: receipt.effect,
    isolationProfile: receipt.isolationProfile,
    ...(receipt.environmentProfile ? { environmentProfile: receipt.environmentProfile } : {}),
    ...(receipt.environmentDigest ? { environmentDigest: receipt.environmentDigest } : {}),
    decisionId: receipt.decisionId,
    ...(receipt.code ? { code: receipt.code } : {}),
    ...receipt.correlation,
  })
}

export function projectPiExecutionReceiptTelemetry(
  receipt: PiHarnessExecutionReceiptSummaryV1,
): PiTelemetryProjection {
  const name = receipt.mcpServer && receipt.mcpTool
    ? 'mcp.completed'
    : ['plugin-hook', 'plugin-agent-hook', 'plugin-mcp-hook', 'plugin-http-hook'].includes(receipt.semanticId)
      ? 'hook.completed'
      : 'tool.completed'
  return {
    name,
    outcome: receipt.outcome === 'timed-out' ? 'error' : receipt.outcome,
    durationMs: receipt.completedAt - receipt.startedAt,
    semanticId: receipt.semanticId,
  }
}

export function projectPiPermissionTelemetry(
  receipt: Pick<PiPermissionReceiptV1, 'outcome' | 'binding'>,
): PiTelemetryProjection | undefined {
  const semanticId = receipt.binding.semanticId
  if (typeof semanticId !== 'string' || semanticId.length > MAX_ID || !SAFE_ID.test(semanticId)) return undefined
  return {
    name: 'permission.decided',
    outcome: receipt.outcome === 'allow' ? 'success' : 'denied',
    semanticId,
  }
}

export function parseSafeExecutionReceiptInput(value: unknown): SafeExecutionReceiptInputV1 {
  const input = record(value)
  const allowed = new Set([
    'executionId', 'semanticId', 'outcome', 'startedAt', 'completedAt', 'manifestGeneration',
    'responseEpoch', 'effect', 'isolationProfile', 'environmentProfile', 'environmentDigest', 'decisionId', 'code', 'parentExecutionId',
    'checkpointId', 'processId', 'childIds', 'workflowId', 'goalId', 'goalRevision', 'mcpServer', 'mcpTool',
  ])
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('execution-receipt-field-invalid')
  const startedAt = integer(input.startedAt)
  const completedAt = integer(input.completedAt)
  if (completedAt < startedAt) throw new Error('execution-receipt-timing-invalid')
  const optionalId = (key: string) => input[key] === undefined ? undefined : safeId(input[key])
  const goalId = optionalId('goalId')
  if ((goalId === undefined) !== (input.goalRevision === undefined)) throw new Error('execution-receipt-goal-reference-invalid')
  const goalRevision = input.goalRevision === undefined ? undefined : integer(input.goalRevision)
  if (goalRevision !== undefined && goalRevision < 1) throw new Error('execution-receipt-goal-reference-invalid')
  const isolationProfile = input.isolationProfile
  if (typeof isolationProfile !== 'string' || isolationProfile.length < 1
    || isolationProfile.length > MAX_ID || !SAFE_ISOLATION_PROFILE.test(isolationProfile)) {
    throw new Error('execution-receipt-isolation-profile-invalid')
  }
  const childIds = input.childIds === undefined ? undefined : (() => {
    if (!Array.isArray(input.childIds) || input.childIds.length > 8) throw new Error('execution-receipt-child-ids-invalid')
    return Object.freeze(input.childIds.map(value => safeId(value)))
  })()
  return Object.freeze({
    executionId: safeId(input.executionId),
    semanticId: safeId(input.semanticId),
    outcome: enumValue(input.outcome, ['success', 'error', 'denied', 'cancelled', 'timed-out'] as const),
    startedAt,
    completedAt,
    manifestGeneration: safeId(input.manifestGeneration),
    responseEpoch: integer(input.responseEpoch),
    effect: enumValue(input.effect, ['read', 'workspaceMutation', 'externalMutation', 'unknown'] as const),
    isolationProfile,
    ...(input.environmentProfile === undefined ? {} : { environmentProfile: enumValue(input.environmentProfile, ['restricted', 'explicit', 'trusted-host'] as const) }),
    ...(input.environmentDigest === undefined ? {} : { environmentDigest: environmentDigest(input.environmentDigest) }),
    decisionId: safeId(input.decisionId),
    ...(input.code === undefined ? {} : { code: safeId(input.code, MAX_CODE) }),
    ...(optionalId('parentExecutionId') ? { parentExecutionId: optionalId('parentExecutionId') } : {}),
    ...(optionalId('checkpointId') ? { checkpointId: optionalId('checkpointId') } : {}),
    ...(optionalId('processId') ? { processId: optionalId('processId') } : {}),
    ...(childIds ? { childIds } : {}),
    ...(optionalId('workflowId') ? { workflowId: optionalId('workflowId') } : {}),
    ...(goalId ? { goalId, goalRevision: goalRevision! } : {}),
    ...(optionalId('mcpServer') ? { mcpServer: optionalId('mcpServer') } : {}),
    ...(optionalId('mcpTool') ? { mcpTool: optionalId('mcpTool') } : {}),
  })
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('execution-receipt-invalid')
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('execution-observation-field-invalid')
}

function safeId(value: unknown, max = MAX_ID): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !SAFE_ID.test(value)) {
    throw new Error('execution-receipt-id-invalid')
  }
  return value
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('execution-receipt-integer-invalid')
  return value as number
}

function environmentDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('execution-receipt-environment-digest-invalid')
  return value
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error('execution-receipt-enum-invalid')
  return value as T
}

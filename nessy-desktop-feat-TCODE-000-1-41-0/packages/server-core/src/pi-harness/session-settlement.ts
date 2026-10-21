/**
 * The single server-owned answer to "may settled-session work run now?".
 *
 * Goal evaluation, compaction and scheduling consume this projection instead of
 * each inventing a partial idle check. Counts are used rather than booleans so
 * producers cannot accidentally report settled while parallel work remains.
 */
export interface SessionSettlementInputsV1 {
  activeForegroundModelTurns: number
  activeWorkflowEvaluators: number
  activeChildren: number
  activeProcesses: number
  pendingPermissions: number
  pendingAskUser: number
  dueImmediateTasks: number
}

export type SessionSettlementPendingDomainV1 =
  | 'foreground_model_turn'
  | 'workflow_evaluator'
  | 'child'
  | 'process'
  | 'permission'
  | 'ask_user'
  | 'immediate_task'

export interface SessionSettlementV1 {
  schemaVersion: 1
  settled: boolean
  pending: readonly SessionSettlementPendingDomainV1[]
}

const DOMAIN_COUNTS: readonly [
  keyof SessionSettlementInputsV1,
  SessionSettlementPendingDomainV1,
][] = Object.freeze([
  ['activeForegroundModelTurns', 'foreground_model_turn'],
  ['activeWorkflowEvaluators', 'workflow_evaluator'],
  ['activeChildren', 'child'],
  ['activeProcesses', 'process'],
  ['pendingPermissions', 'permission'],
  ['pendingAskUser', 'ask_user'],
  ['dueImmediateTasks', 'immediate_task'],
])

export function computeSessionSettlementV1(inputs: SessionSettlementInputsV1): SessionSettlementV1 {
  const pending: SessionSettlementPendingDomainV1[] = []
  for (const [field, domain] of DOMAIN_COUNTS) {
    const count = inputs[field]
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`session-settlement-invalid-count:${field}`)
    }
    if (count > 0) pending.push(domain)
  }
  return Object.freeze({
    schemaVersion: 1,
    settled: pending.length === 0,
    pending: Object.freeze(pending),
  })
}

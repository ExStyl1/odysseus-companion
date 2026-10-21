import type {
  PiHarnessGoalStatusV1,
  PiHarnessSessionRefV1,
  PiHarnessSessionSettlementV1,
} from './pi-harness-runtime.ts'

export type PiAgentViewStateV1 = 'working' | 'needs_input' | 'idle' | 'completed' | 'failed' | 'stopped'
export type PiAgentViewResidencyV1 = 'hot' | 'cold' | 'recovering' | 'updating' | 'lost'
export type PiAgentViewReasonCodeV1 =
  | 'runtime_ready' | 'runtime_not_started' | 'runtime_recovering'
  | 'runtime_updating' | 'runtime_owner_lost'

export interface PiAgentViewTaskSummaryV1 {
  total: number
  active: number
  completed: number
  blocked: number
}

export interface PiAgentViewGoalSummaryV1 {
  status: PiHarnessGoalStatusV1
  budgets: { turnLimit: number; tokenLimit: number; costLimitUsd: number; elapsedLimitMs: number }
  accounting: { turns: number; tokens: number; costUsd: number; elapsedMs: number; resumeCount: number }
}

export interface PiAgentViewEntryV1 {
  schemaVersion: 1
  session: PiHarnessSessionRefV1
  projectLabel: string
  lastActivity: number
  state: PiAgentViewStateV1
  residency: PiAgentViewResidencyV1
  reasonCode: PiAgentViewReasonCodeV1
  errorCode?: 'session_failed' | 'runtime_owner_lost'
  task?: PiAgentViewTaskSummaryV1
  goal?: PiAgentViewGoalSummaryV1
  /**
   * P6.57 — OPTIONAL, because the listing is no longer Pi-only.
   *
   * These three counters are Pi constructs: its child sessions, its process
   * supervisor and its background workflow evaluators. On a claude or codex
   * session there is nothing to count, and `0` would be a CLAIM that nothing is
   * running where the truth is that nothing is tracked. Absent says the second;
   * a zero says the first, and the two are not the same answer.
   *
   * Everything else on this entry is host-side and true on all three runtimes,
   * which is why the entry itself is not gated.
   */
  active?: { children: number; processes: number; workflows: number }
  needsInput?: { kind: 'permission' | 'ask_user' | 'plan'; requestId: string }
  context: {
    mode?: 'normal' | 'bare'
    inputTokens?: number | null
    contextWindow?: number | null
    percent?: number | null
    stale?: boolean
  }
  capabilityGeneration?: string
  settlement: PiHarnessSessionSettlementV1
  receiptCount: number
}

export interface PiAgentViewPageRequestV1 {
  schemaVersion: 1
  cursor?: string
  limit?: number
}

export interface PiAgentViewPageV1 {
  schemaVersion: 1
  items: readonly PiAgentViewEntryV1[]
  nextCursor?: string
}

export type PiAgentViewControlRequestV1 = {
  schemaVersion: 1
  session: PiHarnessSessionRefV1
  action: 'open' | 'stop' | 'resume'
}

export interface PiAgentViewControlResultV1 {
  schemaVersion: 1
  ok: boolean
  session?: PiHarnessSessionRefV1
  error?: string
}

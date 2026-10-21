import type {
  PiAgentViewControlRequestV1,
  PiAgentViewControlResultV1,
  PiAgentViewEntryV1,
  PiAgentViewPageRequestV1,
  PiAgentViewPageV1,
  PiHarnessSessionSettlementV1,
} from '@nessy-agent/core/types'

const MAX_PAGE = 50
const MAX_ID = 256
const MAX_CURSOR = 512

function fail(): never { throw new Error('pi-agent-view-invalid') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some(key => !allowed.has(key))) fail()
}
function text(value: unknown, max = MAX_ID): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) fail()
  return value
}
function safeId(value: unknown): string {
  const parsed = text(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(parsed)) fail()
  return parsed
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail()
  return value as number
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail()
  return value
}
function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail()
  return value as T
}
function session(value: unknown) {
  const input = record(value); exact(input, ['workspaceId', 'sessionId'])
  return Object.freeze({ workspaceId: safeId(input.workspaceId), sessionId: safeId(input.sessionId) })
}
function settlement(value: unknown): PiHarnessSessionSettlementV1 {
  const input = record(value); exact(input, ['schemaVersion', 'settled', 'pending'])
  if (input.schemaVersion !== 1 || typeof input.settled !== 'boolean' || !Array.isArray(input.pending) || input.pending.length > 7) fail()
  const pending = Object.freeze(input.pending.map(item => enumValue(item, ['foreground_model_turn', 'workflow_evaluator', 'child', 'process', 'permission', 'ask_user', 'immediate_task'] as const)))
  if (new Set(pending).size !== pending.length || input.settled !== (pending.length === 0)) fail()
  return Object.freeze({ schemaVersion: 1, settled: input.settled, pending })
}

export function parsePiAgentViewPageRequestV1(value: unknown): PiAgentViewPageRequestV1 {
  const input = record(value); exact(input, ['schemaVersion', 'cursor', 'limit'])
  if (input.schemaVersion !== 1) fail()
  const cursor = input.cursor === undefined ? undefined : text(input.cursor, MAX_CURSOR)
  if (cursor && !/^[A-Za-z0-9_-]+$/.test(cursor)) fail()
  const limit = input.limit === undefined ? undefined : integer(input.limit)
  if (limit !== undefined && (limit < 1 || limit > MAX_PAGE)) fail()
  return Object.freeze({ schemaVersion: 1, ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) })
}

function parseEntry(value: unknown): PiAgentViewEntryV1 {
  const input = record(value)
  exact(input, ['schemaVersion', 'session', 'projectLabel', 'lastActivity', 'state', 'residency', 'reasonCode', 'errorCode', 'task', 'goal', 'active', 'needsInput', 'context', 'capabilityGeneration', 'settlement', 'receiptCount'])
  if (input.schemaVersion !== 1) fail()
  const projectLabel = text(input.projectLabel, 128)
  if (/[\\/]/.test(projectLabel)) fail()
  const task = input.task === undefined ? undefined : (() => {
    const raw = record(input.task); exact(raw, ['total', 'active', 'completed', 'blocked'])
    return Object.freeze({ total: integer(raw.total), active: integer(raw.active), completed: integer(raw.completed), blocked: integer(raw.blocked) })
  })()
  const goal = input.goal === undefined ? undefined : (() => {
    const raw = record(input.goal); exact(raw, ['status', 'budgets', 'accounting'])
    const budgets = record(raw.budgets); exact(budgets, ['turnLimit', 'tokenLimit', 'costLimitUsd', 'elapsedLimitMs'])
    const accounting = record(raw.accounting); exact(accounting, ['turns', 'tokens', 'costUsd', 'elapsedMs', 'resumeCount'])
    return Object.freeze({
      status: enumValue(raw.status, ['active', 'complete', 'blocked', 'cancelled', 'budget_exhausted'] as const),
      budgets: Object.freeze({ turnLimit: integer(budgets.turnLimit), tokenLimit: integer(budgets.tokenLimit), costLimitUsd: finite(budgets.costLimitUsd), elapsedLimitMs: integer(budgets.elapsedLimitMs) }),
      accounting: Object.freeze({ turns: integer(accounting.turns), tokens: integer(accounting.tokens), costUsd: finite(accounting.costUsd), elapsedMs: integer(accounting.elapsedMs), resumeCount: integer(accounting.resumeCount) }),
    })
  })()
  // P6.57 — absent on a non-Pi session, and that is a different answer from
  // three zeros. Decoded the same way every other optional field on this entry
  // is, so an unknown key inside it still fails.
  const active = input.active === undefined ? undefined : (() => {
    const raw = record(input.active); exact(raw, ['children', 'processes', 'workflows'])
    return Object.freeze({ children: integer(raw.children), processes: integer(raw.processes), workflows: integer(raw.workflows) })
  })()
  const needsInput = input.needsInput === undefined ? undefined : (() => {
    const raw = record(input.needsInput); exact(raw, ['kind', 'requestId'])
    return Object.freeze({ kind: enumValue(raw.kind, ['permission', 'ask_user', 'plan'] as const), requestId: safeId(raw.requestId) })
  })()
  const contextValue = record(input.context); exact(contextValue, ['mode', 'inputTokens', 'contextWindow', 'percent', 'stale'])
  const context = Object.freeze({
    ...(contextValue.mode === undefined ? {} : { mode: enumValue(contextValue.mode, ['normal', 'bare'] as const) }),
    ...(contextValue.inputTokens === undefined ? {} : { inputTokens: contextValue.inputTokens === null ? null : integer(contextValue.inputTokens) }),
    ...(contextValue.contextWindow === undefined ? {} : { contextWindow: contextValue.contextWindow === null ? null : integer(contextValue.contextWindow) }),
    ...(contextValue.percent === undefined ? {} : { percent: contextValue.percent === null ? null : finite(contextValue.percent) }),
    ...(contextValue.stale === undefined ? {} : (() => { if (typeof contextValue.stale !== 'boolean') fail(); return { stale: contextValue.stale } })()),
  })
  return Object.freeze({
    schemaVersion: 1,
    session: session(input.session),
    projectLabel,
    lastActivity: integer(input.lastActivity),
    state: enumValue(input.state, ['working', 'needs_input', 'idle', 'completed', 'failed', 'stopped'] as const),
    residency: enumValue(input.residency, ['hot', 'cold', 'recovering', 'updating', 'lost'] as const),
    reasonCode: enumValue(input.reasonCode, ['runtime_ready', 'runtime_not_started', 'runtime_recovering', 'runtime_updating', 'runtime_owner_lost'] as const),
    ...(input.errorCode === undefined ? {} : { errorCode: enumValue(input.errorCode, ['session_failed', 'runtime_owner_lost'] as const) }),
    ...(task ? { task } : {}),
    ...(goal ? { goal } : {}),
    ...(active ? { active } : {}),
    ...(needsInput ? { needsInput } : {}),
    context,
    ...(input.capabilityGeneration === undefined ? {} : { capabilityGeneration: safeId(input.capabilityGeneration) }),
    settlement: settlement(input.settlement),
    receiptCount: integer(input.receiptCount),
  })
}

export function parsePiAgentViewPageV1(value: unknown): PiAgentViewPageV1 {
  const input = record(value); exact(input, ['schemaVersion', 'items', 'nextCursor'])
  if (input.schemaVersion !== 1 || !Array.isArray(input.items) || input.items.length > MAX_PAGE) fail()
  const items = Object.freeze(input.items.map(parseEntry))
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!
    const current = items[index]!
    if (previous.lastActivity < current.lastActivity || (previous.lastActivity === current.lastActivity && previous.session.sessionId >= current.session.sessionId)) fail()
  }
  const nextCursor = input.nextCursor === undefined ? undefined : text(input.nextCursor, MAX_CURSOR)
  if (nextCursor && !/^[A-Za-z0-9_-]+$/.test(nextCursor)) fail()
  return Object.freeze({ schemaVersion: 1, items, ...(nextCursor ? { nextCursor } : {}) })
}

export function parsePiAgentViewControlRequestV1(value: unknown): PiAgentViewControlRequestV1 {
  const input = record(value); exact(input, ['schemaVersion', 'session', 'action'])
  if (input.schemaVersion !== 1) fail()
  return Object.freeze({ schemaVersion: 1, session: session(input.session), action: enumValue(input.action, ['open', 'stop', 'resume'] as const) })
}

export function parsePiAgentViewControlResultV1(value: unknown): PiAgentViewControlResultV1 {
  const input = record(value); exact(input, ['schemaVersion', 'ok', 'session', 'error'])
  if (input.schemaVersion !== 1 || typeof input.ok !== 'boolean') fail()
  if (input.ok) {
    if (input.error !== undefined) fail()
    return Object.freeze({ schemaVersion: 1, ok: true, ...(input.session === undefined ? {} : { session: session(input.session) }) })
  }
  if (input.session !== undefined) fail()
  return Object.freeze({ schemaVersion: 1, ok: false, error: text(input.error, 512) })
}

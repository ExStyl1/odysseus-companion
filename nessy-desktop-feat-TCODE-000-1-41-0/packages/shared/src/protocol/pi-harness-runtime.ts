import type {
  PiHarnessRuntimeControlRequestV1,
  PiHarnessRuntimeControlResultV1,
  PiHarnessRuntimeDomainV1,
  PiHarnessRuntimeEventV1,
  PiHarnessRuntimeSnapshotV1,
} from '@nessy-agent/core/types'

const DOMAINS = new Set<PiHarnessRuntimeDomainV1>([
  'runtime', 'security', 'tasks', 'interactions', 'processes', 'children',
  'worktrees', 'tools', 'context', 'recovery', 'goal',
])
const MAX_ID = 256
const MAX_SUMMARY = 512
const MAX_MESSAGE = 4096
const MAX_GOAL_CONDITION = 8192
const MAX_PROCESS_OUTPUT = 64 * 1024

function fail(): never { throw new Error('pi-harness-runtime-invalid') }
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
function safeId(value: unknown, max = MAX_ID): string {
  const parsed = text(value, max)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(parsed)) fail()
  return parsed
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail()
  return value
}
function boundedArray(value: unknown, max = 50): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail()
  return value
}
function session(value: unknown) {
  const input = record(value)
  exact(input, ['workspaceId', 'sessionId'])
  return { workspaceId: text(input.workspaceId), sessionId: text(input.sessionId) }
}
function askAnswer(value: unknown) {
  const input = record(value)
  if (input.type === 'free_text') {
    exact(input, ['type', 'value'])
    return { type: 'free_text' as const, value: text(input.value, MAX_MESSAGE) }
  }
  if (input.type === 'option') {
    exact(input, ['type', 'value', 'optionIndex'])
    if (!Number.isSafeInteger(input.optionIndex) || (input.optionIndex as number) < 0) fail()
    return { type: 'option' as const, value: text(input.value, MAX_MESSAGE), optionIndex: input.optionIndex as number }
  }
  return fail()
}

function goalBudgets(value: unknown) {
  if (value === undefined) return undefined
  const input = record(value)
  exact(input, ['turnLimit', 'tokenLimit', 'costLimitUsd', 'elapsedLimitMs'])
  const positiveInteger = (raw: unknown, max: number) => {
    if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > max) fail()
    return raw as number
  }
  const cost = input.costLimitUsd === undefined ? undefined : (() => {
    if (typeof input.costLimitUsd !== 'number' || !Number.isFinite(input.costLimitUsd) || input.costLimitUsd <= 0 || input.costLimitUsd > 10_000) fail()
    return input.costLimitUsd
  })()
  return {
    ...(input.turnLimit === undefined ? {} : { turnLimit: positiveInteger(input.turnLimit, 1_000) }),
    ...(input.tokenLimit === undefined ? {} : { tokenLimit: positiveInteger(input.tokenLimit, 100_000_000) }),
    ...(cost === undefined ? {} : { costLimitUsd: cost }),
    ...(input.elapsedLimitMs === undefined ? {} : { elapsedLimitMs: positiveInteger(input.elapsedLimitMs, 30 * 24 * 60 * 60 * 1_000) }),
  }
}

export function parsePiHarnessRuntimeEventV1(value: unknown): PiHarnessRuntimeEventV1 {
  const input = record(value)
  exact(input, ['type', 'sessionId', 'schemaVersion', 'session', 'changedDomains'])
  if (input.type !== 'pi_harness_runtime_invalidated' || input.schemaVersion !== 1 || !Array.isArray(input.changedDomains) || input.changedDomains.length > DOMAINS.size) fail()
  const parsedSession = session(input.session)
  if (text(input.sessionId) !== parsedSession.sessionId) fail()
  const changedDomains = input.changedDomains.map(value => {
    if (typeof value !== 'string' || !DOMAINS.has(value as PiHarnessRuntimeDomainV1)) fail()
    return value as PiHarnessRuntimeDomainV1
  })
  if (new Set(changedDomains).size !== changedDomains.length) fail()
  return Object.freeze({ schemaVersion: 1, session: Object.freeze(parsedSession), changedDomains: Object.freeze(changedDomains) })
}

export function parsePiHarnessRuntimeSnapshotV1(value: unknown): PiHarnessRuntimeSnapshotV1 {
  const input = record(value)
  exact(input, ['schemaVersion', 'session', 'provider', 'available', 'unavailableReason', 'generatedAt', 'manifest', 'taskState', 'goal', 'pendingAsk', 'planState', 'childState', 'mailbox', 'worktrees', 'lspHealth', 'mcpHealth', 'context', 'compaction', 'security', 'settlement', 'executionReceipts', 'checkpoints', 'processes'])
  if (input.schemaVersion !== 1 || typeof input.available !== 'boolean') fail()
  const enumValue = <T extends string>(raw: unknown, values: readonly T[]): T => { // F1.1050: a permission mode below reads an older server's retired `explore` as `plan`, never rejects it
    if (typeof raw !== 'string' || !values.includes(raw as T)) fail()
    return raw as T
  }
  const bool = (raw: unknown): boolean => { if (typeof raw !== 'boolean') fail(); return raw }
  const integer = (raw: unknown): number => { if (!Number.isSafeInteger(raw) || (raw as number) < 0) fail(); return raw as number }
  const nullableInteger = (raw: unknown): number | null => raw === null ? null : integer(raw)
  const digest = (raw: unknown): string => { const value = text(raw, 64); if (!/^[0-9a-f]{64}$/.test(value)) fail(); return value }
  const stringArray = (raw: unknown, max = 50): readonly string[] => Object.freeze(boundedArray(raw, max).map(value => text(value)))
  const provider = enumValue(input.provider, ['pi', 'anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const)
  const unavailableReason = input.unavailableReason === undefined ? undefined : enumValue(input.unavailableReason, ['provider-not-pi', 'pi-runtime-not-started'] as const)
  const manifest = input.manifest === undefined ? undefined : (() => {
    const value = record(input.manifest); exact(value, ['surfaceVersion', 'generation', 'manifestHash', 'provenance', 'contextProfile', 'responseEpoch'])
    if (value.surfaceVersion !== 2) fail()
    return Object.freeze({ surfaceVersion: 2 as const, generation: text(value.generation), manifestHash: text(value.manifestHash), provenance: stringArray(value.provenance), contextProfile: enumValue(value.contextProfile, ['normal', 'bare'] as const), responseEpoch: integer(value.responseEpoch) })
  })()
  const taskState = input.taskState === undefined ? undefined : (() => {
    const value = record(input.taskState); exact(value, ['revision', 'tasks'])
    return Object.freeze({ revision: integer(value.revision), tasks: Object.freeze(boundedArray(value.tasks).map(raw => { const task = record(raw); exact(task, ['id', 'title', 'status', 'blockedBy']); return Object.freeze({ id: text(task.id), title: text(task.title, MAX_SUMMARY), status: enumValue(task.status, ['pending', 'in_progress', 'completed', 'deleted'] as const), blockedBy: stringArray(task.blockedBy, 25) }) })) })
  })()
  const goal = input.goal === undefined ? undefined : (() => {
    const value = record(input.goal)
    exact(value, ['id', 'revision', 'status', 'source', 'creator', 'condition', 'budgets', 'accounting', 'blocking', 'lastEvaluation', 'createdAt', 'updatedAt'])
    const budget = record(value.budgets); exact(budget, ['turnLimit', 'tokenLimit', 'costLimitUsd', 'elapsedLimitMs'])
    const accountingValue = record(value.accounting); exact(accountingValue, ['turns', 'tokens', 'costUsd', 'elapsedMs', 'resumeCount'])
    const positive = (raw: unknown) => { const parsed = finite(raw); if (parsed <= 0) fail(); return parsed }
    const positiveInteger = (raw: unknown) => { const parsed = integer(raw); if (parsed < 1) fail(); return parsed }
    const nonnegative = (raw: unknown) => { const parsed = finite(raw); if (parsed < 0) fail(); return parsed }
    const blocking = value.blocking === undefined ? undefined : (() => {
      const raw = record(value.blocking); exact(raw, ['condition', 'blockedBy', 'consecutive'])
      const consecutive = integer(raw.consecutive); if (consecutive < 1) fail()
      return Object.freeze({ condition: text(raw.condition, MAX_SUMMARY), blockedBy: enumValue(raw.blockedBy, ['user', 'external'] as const), consecutive })
    })()
    const lastEvaluation = value.lastEvaluation === undefined ? undefined : (() => {
      const raw = record(value.lastEvaluation); exact(raw, ['source', 'verdict', 'reason', 'evidence', 'evaluatedAt'])
      return Object.freeze({
        source: enumValue(raw.source, ['manual', 'evaluator', 'budget'] as const),
        verdict: enumValue(raw.verdict, ['not_complete', 'complete_suggested', 'completed', 'blocked', 'cancelled', 'budget_exhausted', 'resumed'] as const),
        reason: text(raw.reason, MAX_SUMMARY),
        evidence: Object.freeze(boundedArray(raw.evidence, 8).map(item => text(item, MAX_SUMMARY))),
        evaluatedAt: integer(raw.evaluatedAt),
      })
    })()
    return Object.freeze({
      id: safeId(value.id), revision: positiveInteger(value.revision),
      status: enumValue(value.status, ['active', 'complete', 'blocked', 'cancelled', 'budget_exhausted'] as const),
      source: enumValue(value.source, ['user', 'agent', 'automation'] as const),
      creator: safeId(value.creator), condition: text(value.condition, 1_024),
      budgets: Object.freeze({ turnLimit: positiveInteger(budget.turnLimit), tokenLimit: positiveInteger(budget.tokenLimit), costLimitUsd: positive(budget.costLimitUsd), elapsedLimitMs: positiveInteger(budget.elapsedLimitMs) }),
      accounting: Object.freeze({ turns: integer(accountingValue.turns), tokens: integer(accountingValue.tokens), costUsd: nonnegative(accountingValue.costUsd), elapsedMs: integer(accountingValue.elapsedMs), resumeCount: integer(accountingValue.resumeCount) }),
      ...(blocking ? { blocking } : {}), ...(lastEvaluation ? { lastEvaluation } : {}),
      createdAt: integer(value.createdAt), updatedAt: integer(value.updatedAt),
    })
  })()
  const pendingAsk = input.pendingAsk === undefined ? undefined : (() => {
    // D1.264 — `questions` is R7's batched AskUserQuestion superset. It is
    // declared on `PiHarnessPendingAskSummaryV1`, it is emitted by
    // `SessionManager.getPiHarnessRuntimeSnapshot`, and it was in no `exact()`
    // list — so every batched ask threw `pi-harness-runtime-invalid` and took
    // the whole snapshot with it. Widened here rather than bounded at the
    // producer (the opposite of the `mcpHealth` repair in the same row) because
    // the wire TYPE and the producer already agree; the parser was the only
    // narrow one.
    const value = record(input.pendingAsk); exact(value, ['requestId', 'question', 'options', 'allowFreeText', 'timeoutMs', 'questions'])
    // PARSED and not merely admitted: a field this list allows and drops is the
    // inert half of the same defect — the payload would cross and the renderer
    // would still never see the batched questions. Bounds are the producer's
    // own (four questions, four options each).
    const questions = value.questions === undefined ? undefined : Object.freeze(boundedArray(value.questions, 4).map(raw => {
      const question = record(raw); exact(question, ['question', 'header', 'options', 'multiSelect'])
      return Object.freeze({
        question: text(question.question, MAX_SUMMARY),
        ...(question.header === undefined ? {} : { header: text(question.header, MAX_SUMMARY) }),
        options: Object.freeze(boundedArray(question.options, 4).map(rawOption => {
          const option = record(rawOption); exact(option, ['label', 'description'])
          return Object.freeze({
            label: text(option.label),
            ...(option.description === undefined ? {} : { description: text(option.description, MAX_SUMMARY) }),
          })
        })),
        multiSelect: bool(question.multiSelect),
      })
    }))
    return Object.freeze({ requestId: text(value.requestId), question: text(value.question, MAX_SUMMARY), options: stringArray(value.options, 20), allowFreeText: bool(value.allowFreeText), ...(value.timeoutMs === undefined ? {} : { timeoutMs: integer(value.timeoutMs) }), ...(questions === undefined ? {} : { questions }) })
  })()
  const planState = input.planState === undefined ? undefined : (() => {
    const value = record(input.planState)
    if (value.kind === 'inactive') { exact(value, ['kind', 'revision']); return Object.freeze({ kind: 'inactive' as const, revision: integer(value.revision) }) }
    if (value.kind === 'planning') { exact(value, ['kind', 'revision', 'previousMode']); return Object.freeze({ kind: 'planning' as const, revision: integer(value.revision), previousMode: enumValue(value.previousMode === 'explore' ? 'plan' : value.previousMode, ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) }) }
    if (value.kind === 'awaiting_user') { exact(value, ['kind', 'revision', 'previousMode', 'submissionId', 'notificationDispatched']); return Object.freeze({ kind: 'awaiting_user' as const, revision: integer(value.revision), previousMode: enumValue(value.previousMode === 'explore' ? 'plan' : value.previousMode, ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const), submissionId: text(value.submissionId), notificationDispatched: bool(value.notificationDispatched) }) }
    return fail()
  })()
  const childState = input.childState === undefined ? undefined : (() => {
    const value = record(input.childState); exact(value, ['revision', 'sealedOwnerTaskIds', 'children'])
    return Object.freeze({ revision: integer(value.revision), sealedOwnerTaskIds: stringArray(value.sealedOwnerTaskIds), children: Object.freeze(boundedArray(value.children).map(raw => {
      // `effort`/`model` are the last two entries on purpose: a summary from a
      // host that predates them arrives with both absent, and `exact` only
      // rejects keys it does not KNOW, so listing them keeps old and new
      // payloads parsing side by side.
      const child = record(raw); exact(child, ['agentId', 'ownerTaskId', 'backgroundTaskId', 'worktreeLeaseId', 'agent', 'task', 'status', 'background', 'inputTokens', 'outputTokens', 'costUsd', 'error', 'effort', 'model'])
      return Object.freeze({ agentId: text(child.agentId), ...(child.ownerTaskId === undefined ? {} : { ownerTaskId: text(child.ownerTaskId) }), ...(child.backgroundTaskId === undefined ? {} : { backgroundTaskId: text(child.backgroundTaskId) }), ...(child.worktreeLeaseId === undefined ? {} : { worktreeLeaseId: text(child.worktreeLeaseId) }), agent: text(child.agent), ...(child.task === undefined ? {} : { task: text(child.task) }), status: enumValue(child.status, ['starting', 'running', 'completed', 'failed', 'stopped', 'interrupted'] as const), background: bool(child.background), ...(child.inputTokens === undefined ? {} : { inputTokens: integer(child.inputTokens) }), ...(child.outputTokens === undefined ? {} : { outputTokens: integer(child.outputTokens) }), ...(child.costUsd === undefined ? {} : { costUsd: finite(child.costUsd) }), ...(child.error === undefined ? {} : { error: text(child.error, MAX_SUMMARY) }), ...(child.effort === undefined ? {} : { effort: enumValue(child.effort, ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const) }), ...(child.model === undefined ? {} : { model: text(child.model) }) })
    })) })
  })()
  const mailbox = input.mailbox === undefined ? undefined : (() => { const value = record(input.mailbox); exact(value, ['revision', 'messageCount']); return Object.freeze({ revision: integer(value.revision), messageCount: integer(value.messageCount) }) })()
  const worktrees = Object.freeze(boundedArray(input.worktrees).map(raw => { const value = record(raw); exact(value, ['worktreeLeaseId', 'ownerAgentId', 'branch', 'status']); return Object.freeze({ worktreeLeaseId: text(value.worktreeLeaseId), ownerAgentId: text(value.ownerAgentId), branch: text(value.branch), status: enumValue(value.status, ['creating', 'active'] as const) }) }))
  const lspHealth = input.lspHealth === undefined ? undefined : (() => { const value = record(input.lspHealth); if (value.status === 'ready' || value.status === 'connecting') { exact(value, ['status']); return Object.freeze({ status: value.status }) } exact(value, ['status', 'reason']); return Object.freeze({ status: enumValue(value.status, ['unavailable', 'failed'] as const), reason: text(value.reason, MAX_SUMMARY) }) })()
  const mcpHealth = input.mcpHealth === undefined ? undefined : (() => { const value = record(input.mcpHealth); exact(value, ['status', 'connected', 'failed']); return Object.freeze({ status: enumValue(value.status, ['unavailable', 'ready', 'degraded'] as const), connected: stringArray(value.connected), failed: stringArray(value.failed) }) })()
  const contextValue = record(input.context); exact(contextValue, ['capabilityGeneration', 'sourceCount', 'skillCount', 'mcpServerCount', 'hookCount', 'promptLayerCount', 'memoryCount', 'inputTokens', 'contextWindow', 'percent', 'stale'])
  const context = Object.freeze({ ...(contextValue.capabilityGeneration === undefined ? {} : { capabilityGeneration: text(contextValue.capabilityGeneration) }), sourceCount: integer(contextValue.sourceCount), skillCount: integer(contextValue.skillCount), mcpServerCount: integer(contextValue.mcpServerCount), hookCount: integer(contextValue.hookCount), promptLayerCount: integer(contextValue.promptLayerCount), memoryCount: integer(contextValue.memoryCount), ...(contextValue.inputTokens === undefined ? {} : { inputTokens: contextValue.inputTokens === null ? null : integer(contextValue.inputTokens) }), ...(contextValue.contextWindow === undefined ? {} : { contextWindow: contextValue.contextWindow === null ? null : integer(contextValue.contextWindow) }), ...(contextValue.percent === undefined ? {} : { percent: contextValue.percent === null ? null : finite(contextValue.percent) }), ...(contextValue.stale === undefined ? {} : { stale: bool(contextValue.stale) }) })
  const compactionValue = record(input.compaction); exact(compactionValue, ['isCompacting', 'autoCompactionEnabled', 'remainingBeforeAutoCompact', 'pendingPlan'])
  const compaction = Object.freeze({ isCompacting: bool(compactionValue.isCompacting), ...(compactionValue.autoCompactionEnabled === undefined ? {} : { autoCompactionEnabled: compactionValue.autoCompactionEnabled === null ? null : bool(compactionValue.autoCompactionEnabled) }), ...(compactionValue.remainingBeforeAutoCompact === undefined ? {} : { remainingBeforeAutoCompact: compactionValue.remainingBeforeAutoCompact === null ? null : integer(compactionValue.remainingBeforeAutoCompact) }), pendingPlan: bool(compactionValue.pendingPlan) })
  const securityValue = record(input.security); exact(securityValue, ['permissionMode', 'contextProfile', 'projectTrustState', 'risk', 'permissionSource', 'pendingPermissions', 'isolationProfiles', 'hookCount', 'filesystemScope'])
  const filesystemScope = securityValue.filesystemScope === undefined ? undefined : (() => {
    const value = record(securityValue.filesystemScope); exact(value, ['primaryRoot', 'hasProject', 'additionalRoots', 'configDiagnostics'])
    return Object.freeze({
      primaryRoot: text(value.primaryRoot, MAX_SUMMARY),
      hasProject: bool(value.hasProject),
      additionalRoots: Object.freeze(boundedArray(value.additionalRoots).map(raw => { const root = record(raw); exact(root, ['receiptId', 'canonicalRoot', 'access', 'expires']); return Object.freeze({ receiptId: text(root.receiptId), canonicalRoot: text(root.canonicalRoot, MAX_SUMMARY), access: enumValue(root.access, ['read', 'write'] as const), expires: enumValue(root.expires, ['request', 'session'] as const) }) })),
      ...(value.configDiagnostics === undefined ? {} : { configDiagnostics: Object.freeze(boundedArray(value.configDiagnostics).map(raw => { const diagnostic = record(raw); exact(diagnostic, ['severity', 'code']); return Object.freeze({ severity: enumValue(diagnostic.severity, ['error', 'warning'] as const), code: text(diagnostic.code) }) })) }),
    })
  })()
  const security = Object.freeze({ ...(securityValue.permissionMode === undefined ? {} : { permissionMode: enumValue(securityValue.permissionMode === 'explore' ? 'plan' : securityValue.permissionMode, ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) }), ...(securityValue.contextProfile === undefined ? {} : { contextProfile: enumValue(securityValue.contextProfile, ['normal', 'bare'] as const) }), projectTrustState: enumValue(securityValue.projectTrustState, ['none', 'trusted', 'blocked'] as const), risk: enumValue(securityValue.risk, ['none', 'pending-approval'] as const), permissionSource: enumValue(securityValue.permissionSource, ['session-mode'] as const), pendingPermissions: Object.freeze(boundedArray(securityValue.pendingPermissions).map(raw => { const value = record(raw); exact(value, ['requestId', 'type', 'agentId', 'source']); return Object.freeze({ requestId: text(value.requestId), ...(value.type === undefined ? {} : { type: enumValue(value.type, ['bash', 'file_write', 'mcp_mutation', 'api_mutation', 'admin_approval', 'workflow_launch', 'worktree_approval', 'worktree_setup', 'worktree_cleanup', 'ask_user', 'outside_root', 'permission_dsl'] as const) }), ...(value.agentId === undefined ? {} : { agentId: text(value.agentId) }), source: enumValue(value.source, ['session-permission'] as const) }) })), isolationProfiles: stringArray(securityValue.isolationProfiles), hookCount: integer(securityValue.hookCount), ...(filesystemScope ? { filesystemScope } : {}) })
  const settlementValue = record(input.settlement); exact(settlementValue, ['schemaVersion', 'settled', 'pending'])
  if (settlementValue.schemaVersion !== 1) fail()
  const settlementPending = Object.freeze(boundedArray(settlementValue.pending, 7).map(value => enumValue(value, ['foreground_model_turn', 'workflow_evaluator', 'child', 'process', 'permission', 'ask_user', 'immediate_task'] as const)))
  if (new Set(settlementPending).size !== settlementPending.length) fail()
  const settlementSettled = bool(settlementValue.settled)
  if (settlementSettled !== (settlementPending.length === 0)) fail()
  const settlement = Object.freeze({ schemaVersion: 1 as const, settled: settlementSettled, pending: settlementPending })
  let previousReceiptSequence = 0
  const executionReceipts = Object.freeze(boundedArray(input.executionReceipts).map(raw => {
    const value = record(raw)
    exact(value, ['sequence', 'executionId', 'semanticId', 'outcome', 'startedAt', 'completedAt', 'manifestGeneration', 'responseEpoch', 'effect', 'isolationProfile', 'environmentProfile', 'environmentDigest', 'decisionId', 'code', 'parentExecutionId', 'checkpointId', 'processId', 'childIds', 'workflowId', 'goalId', 'goalRevision', 'mcpServer', 'mcpTool'])
    const sequence = integer(value.sequence)
    if (sequence <= previousReceiptSequence) fail()
    previousReceiptSequence = sequence
    const startedAt = integer(value.startedAt)
    const completedAt = integer(value.completedAt)
    if (completedAt < startedAt) fail()
    const optionalId = (key: string, max = MAX_ID) => value[key] === undefined ? undefined : safeId(value[key], max)
    const goalId = optionalId('goalId')
    if ((goalId === undefined) !== (value.goalRevision === undefined)) fail()
    const goalRevision = value.goalRevision === undefined ? undefined : integer(value.goalRevision)
    if (goalRevision !== undefined && goalRevision < 1) fail()
    return Object.freeze({
      sequence,
      executionId: safeId(value.executionId),
      semanticId: safeId(value.semanticId),
      outcome: enumValue(value.outcome, ['success', 'error', 'denied', 'cancelled', 'timed-out'] as const),
      startedAt,
      completedAt,
      manifestGeneration: safeId(value.manifestGeneration),
      responseEpoch: integer(value.responseEpoch),
      effect: enumValue(value.effect, ['read', 'workspaceMutation', 'externalMutation', 'unknown'] as const),
      isolationProfile: text(value.isolationProfile),
      ...(value.environmentProfile === undefined ? {} : { environmentProfile: enumValue(value.environmentProfile, ['restricted', 'explicit', 'trusted-host'] as const) }),
      ...(value.environmentDigest === undefined ? {} : { environmentDigest: digest(value.environmentDigest) }),
      decisionId: safeId(value.decisionId),
      ...(optionalId('code', 128) ? { code: optionalId('code', 128) } : {}),
      ...(optionalId('parentExecutionId') ? { parentExecutionId: optionalId('parentExecutionId') } : {}),
      ...(optionalId('checkpointId') ? { checkpointId: optionalId('checkpointId') } : {}),
      ...(optionalId('processId') ? { processId: optionalId('processId') } : {}),
      ...(value.childIds === undefined ? {} : { childIds: Object.freeze(boundedArray(value.childIds, 8).map(childId => safeId(childId))) }),
      ...(optionalId('workflowId') ? { workflowId: optionalId('workflowId') } : {}),
      ...(goalId ? { goalId, goalRevision: goalRevision! } : {}),
      ...(optionalId('mcpServer') ? { mcpServer: optionalId('mcpServer') } : {}),
      ...(optionalId('mcpTool') ? { mcpTool: optionalId('mcpTool') } : {}),
    })
  }))
  const checkpoints = Object.freeze(boundedArray(input.checkpoints).map(raw => {
    const value = record(raw)
    exact(value, ['id', 'adapter', 'toolName', 'fileName', 'existed', 'preimageDigest', 'postimageDigest', 'currentDigest', 'postimageExists', 'currentExists', 'outcome', 'changed', 'conflict', 'createdAt', 'completedAt', 'revertedAt'])
    if (value.adapter !== 'file') fail()
    return Object.freeze({
      id: text(value.id),
      adapter: 'file' as const,
      toolName: text(value.toolName),
      fileName: text(value.fileName),
      existed: bool(value.existed),
      ...(value.preimageDigest === undefined ? {} : { preimageDigest: digest(value.preimageDigest) }),
      ...(value.postimageDigest === undefined ? {} : { postimageDigest: digest(value.postimageDigest) }),
      ...(value.currentDigest === undefined ? {} : { currentDigest: digest(value.currentDigest) }),
      ...(value.postimageExists === undefined ? {} : { postimageExists: bool(value.postimageExists) }),
      currentExists: bool(value.currentExists),
      ...(value.outcome === undefined ? {} : { outcome: enumValue(value.outcome, ['applied', 'no-op', 'failed'] as const) }),
      ...(value.changed === undefined ? {} : { changed: bool(value.changed) }),
      conflict: bool(value.conflict),
      createdAt: text(value.createdAt),
      ...(value.completedAt === undefined ? {} : { completedAt: text(value.completedAt) }),
      ...(value.revertedAt === undefined ? {} : { revertedAt: text(value.revertedAt) }),
    })
  }))
  const processes = Object.freeze(boundedArray(input.processes).map(raw => { const value = record(raw); exact(value, ['handle', 'semanticId', 'startedAt', 'deadlineAt', 'status', 'exitCode', 'signal', 'isolationProfile', 'nextCursor']); return Object.freeze({ handle: text(value.handle), semanticId: text(value.semanticId), startedAt: integer(value.startedAt), deadlineAt: integer(value.deadlineAt), status: enumValue(value.status, ['running', 'exited', 'stopped', 'timed-out', 'lost'] as const), exitCode: nullableInteger(value.exitCode), signal: value.signal === null ? null : text(value.signal), isolationProfile: text(value.isolationProfile), nextCursor: integer(value.nextCursor) }) }))
  if (provider !== 'pi' && (input.available || unavailableReason !== 'provider-not-pi' || manifest)) fail()
  if (provider === 'pi' && !input.available && (unavailableReason !== 'pi-runtime-not-started' || manifest)) fail()
  if (provider === 'pi' && input.available && (!manifest || unavailableReason !== undefined)) fail()
  return Object.freeze({ schemaVersion: 1, session: Object.freeze(session(input.session)), provider, available: input.available, ...(unavailableReason ? { unavailableReason } : {}), generatedAt: finite(input.generatedAt), ...(manifest ? { manifest } : {}), ...(taskState ? { taskState } : {}), ...(goal ? { goal } : {}), ...(pendingAsk ? { pendingAsk } : {}), ...(planState ? { planState } : {}), ...(childState ? { childState } : {}), ...(mailbox ? { mailbox } : {}), worktrees, ...(lspHealth ? { lspHealth } : {}), ...(mcpHealth ? { mcpHealth } : {}), context, compaction, security, settlement, executionReceipts, checkpoints, processes })
}

export function parsePiHarnessRuntimeControlRequestV1(value: unknown): PiHarnessRuntimeControlRequestV1 {
  const input = record(value)
  if (input.schemaVersion !== 1 || typeof input.action !== 'string') fail()
  const base = { schemaVersion: 1 as const, session: session(input.session) }
  switch (input.action) {
    case 'refresh': exact(input, ['schemaVersion', 'session', 'action']); return { ...base, action: 'refresh' }
    case 'stop_process': exact(input, ['schemaVersion', 'session', 'action', 'handle']); return { ...base, action: 'stop_process', handle: text(input.handle) }
    case 'read_process': {
      exact(input, ['schemaVersion', 'session', 'action', 'handle', 'cursor'])
      if (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || (input.cursor as number) < 0)) fail()
      return { ...base, action: 'read_process', handle: text(input.handle), ...(input.cursor === undefined ? {} : { cursor: input.cursor as number }) }
    }
    case 'read_child': {
      exact(input, ['schemaVersion', 'session', 'action', 'agentId', 'cursor'])
      if (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || (input.cursor as number) < 0)) fail()
      return { ...base, action: 'read_child', agentId: text(input.agentId), ...(input.cursor === undefined ? {} : { cursor: input.cursor as number }) }
    }
    case 'stop_child': exact(input, ['schemaVersion', 'session', 'action', 'agentId']); return { ...base, action: 'stop_child', agentId: text(input.agentId) }
    case 'steer_child': exact(input, ['schemaVersion', 'session', 'action', 'agentId', 'message']); return { ...base, action: 'steer_child', agentId: text(input.agentId), message: text(input.message, MAX_MESSAGE) }
    case 'answer_ask': exact(input, ['schemaVersion', 'session', 'action', 'requestId', 'answer']); return { ...base, action: 'answer_ask', requestId: text(input.requestId), answer: askAnswer(input.answer) }
    case 'cancel_ask': exact(input, ['schemaVersion', 'session', 'action', 'requestId']); return { ...base, action: 'cancel_ask', requestId: text(input.requestId) }
    case 'approve_plan': exact(input, ['schemaVersion', 'session', 'action']); return { ...base, action: 'approve_plan' }
    case 'exit_plan': exact(input, ['schemaVersion', 'session', 'action']); return { ...base, action: 'exit_plan' }
    case 'release_worktree': exact(input, ['schemaVersion', 'session', 'action', 'leaseId']); return { ...base, action: 'release_worktree', leaseId: text(input.leaseId) }
    case 'rewind_checkpoint': exact(input, ['schemaVersion', 'session', 'action', 'checkpointId']); return { ...base, action: 'rewind_checkpoint', checkpointId: text(input.checkpointId) }
    case 'goal_create': {
      exact(input, ['schemaVersion', 'session', 'action', 'condition', 'budgets'])
      const budgets = goalBudgets(input.budgets)
      return { ...base, action: 'goal_create', condition: text(input.condition, MAX_GOAL_CONDITION), ...(budgets ? { budgets } : {}) }
    }
    case 'goal_replace': {
      exact(input, ['schemaVersion', 'session', 'action', 'goalId', 'revision', 'condition', 'budgets'])
      if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) fail()
      const budgets = goalBudgets(input.budgets)
      return { ...base, action: 'goal_replace', goalId: safeId(input.goalId), revision: input.revision as number, condition: text(input.condition, MAX_GOAL_CONDITION), ...(budgets ? { budgets } : {}) }
    }
    case 'goal_cancel':
      exact(input, ['schemaVersion', 'session', 'action', 'goalId', 'revision', 'reason'])
      if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) fail()
      return { ...base, action: 'goal_cancel', goalId: safeId(input.goalId), revision: input.revision as number, reason: text(input.reason, 1_000) }
    case 'goal_complete': {
      exact(input, ['schemaVersion', 'session', 'action', 'goalId', 'revision', 'reason', 'evidence'])
      if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) fail()
      const evidence = Object.freeze(boundedArray(input.evidence, 16).map(value => text(value, 2_000)))
      if (evidence.length === 0) fail()
      return { ...base, action: 'goal_complete', goalId: safeId(input.goalId), revision: input.revision as number, reason: text(input.reason, 1_000), evidence }
    }
    case 'goal_blocked': {
      exact(input, ['schemaVersion', 'session', 'action', 'goalId', 'revision', 'blockingCondition', 'blockedBy', 'reason', 'evidence'])
      if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) fail()
      const evidence = Object.freeze(boundedArray(input.evidence, 16).map(value => text(value, 2_000)))
      if (evidence.length === 0) fail()
      const blockedBy = input.blockedBy === 'user' || input.blockedBy === 'external' ? input.blockedBy : fail()
      return { ...base, action: 'goal_blocked', goalId: safeId(input.goalId), revision: input.revision as number, blockingCondition: text(input.blockingCondition, 1_000), blockedBy, reason: text(input.reason, 1_000), evidence }
    }
    case 'goal_resume':
      exact(input, ['schemaVersion', 'session', 'action', 'goalId', 'revision', 'reason'])
      if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) fail()
      return { ...base, action: 'goal_resume', goalId: safeId(input.goalId), revision: input.revision as number, reason: text(input.reason, 1_000) }
    default: return fail()
  }
}

export function parsePiHarnessRuntimeControlResultV1(value: unknown): PiHarnessRuntimeControlResultV1 {
  const input = record(value)
  exact(input, ['schemaVersion', 'ok', 'output', 'nextCursor', 'error'])
  if (input.schemaVersion !== 1 || typeof input.ok !== 'boolean') fail()
  if (!input.ok) {
    if (input.output !== undefined || input.nextCursor !== undefined) fail()
    return Object.freeze({ schemaVersion: 1, ok: false, error: text(input.error, MAX_SUMMARY) })
  }
  if (input.error !== undefined) fail()
  if (input.output !== undefined && (typeof input.output !== 'string' || input.output.length > MAX_PROCESS_OUTPUT)) fail()
  if (input.nextCursor !== undefined && (!Number.isSafeInteger(input.nextCursor) || (input.nextCursor as number) < 0)) fail()
  return Object.freeze({ schemaVersion: 1, ok: true, ...(input.output === undefined ? {} : { output: input.output }), ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor as number }) })
}

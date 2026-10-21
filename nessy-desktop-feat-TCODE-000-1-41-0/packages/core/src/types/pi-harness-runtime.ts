import type { AskUserAnswer } from './message.ts'

export interface PiHarnessSessionRefV1 {
  workspaceId: string
  sessionId: string
}

export type PiHarnessProviderV1 = 'pi' | 'anthropic' | 'codex-runtime' | 'nestor-cloud-agent'
export type PiHarnessPermissionModeV1 = 'dontAsk' | 'plan' | 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions'
export type PiHarnessRuntimeDomainV1 =
  | 'runtime' | 'security' | 'tasks' | 'interactions' | 'processes'
  | 'children' | 'worktrees' | 'tools' | 'context' | 'recovery' | 'goal'

export interface PiHarnessManifestDiagnosticsV1 {
  surfaceVersion: 2
  generation: string
  manifestHash: string
  provenance: readonly string[]
  contextProfile: 'normal' | 'bare'
  responseEpoch: number
}

export interface PiHarnessProcessSnapshotV1 {
  handle: string
  semanticId: string
  startedAt: number
  deadlineAt: number
  status: 'running' | 'exited' | 'stopped' | 'timed-out' | 'lost'
  exitCode: number | null
  signal: string | null
  isolationProfile: string
  nextCursor: number
}

/**
 * One isolation profile's availability on this host, as probed at startup.
 *
 * Read-only diagnosis. `backend` is the same string the execution receipt
 * records for a real run, so a report can be checked against what actually
 * happens rather than trusted on its own. `remediation` is present whenever
 * `available` is false.
 */
export interface IsolationProfileCapabilityV1 {
  available: boolean
  backend?: string
  reason?: string
  remediation?: string
}

/**
 * What a sandboxed command may reach on the network, and which configured
 * network settings bind nothing.
 *
 * Disclosure only. `egress: 'open'` is the shipped default and a recorded
 * decision, not a defect: no isolation backend we have can filter by domain, so
 * the `networked` profile is one bit. Saying so on the settings page is the
 * point — `available` alone reads as "bounded" to an administrator.
 *
 * `unenforceable` carries the resolver's own lines verbatim
 * (`resolveSandboxNetworkEnforcement`), so this surface can never state a second
 * truth about what is enforced.
 */
export interface IsolationNetworkPostureV1 {
  egress: 'open' | 'denied'
  source: 'default' | 'allowManagedDomainsOnly'
  unenforceable: readonly string[]
}

export interface IsolationCapabilityReportV1 {
  platform: string
  profiles: Record<string, IsolationProfileCapabilityV1>
  /**
   * The resolved `sandbox.enabled` master switch, when the host knows it.
   *
   * Every other field here answers "what COULD this host run", which is a
   * different question from "is any of it applied". Since 2026-08-12 the switch
   * ships off by default, so a report listing available profiles and an egress
   * posture describes a layer that binds nothing at all — a surface that has to
   * say so, or it advertises protection the user does not have. Absent means
   * "not reported here", never "enabled".
   */
  sandboxEnabled?: boolean
  /**
   * Absent when the host built the report without resolved sandbox settings —
   * an on-demand probe in a standalone server. Absent means "not reported here",
   * never "restricted".
   */
  network?: IsolationNetworkPostureV1
}

export interface PiHarnessTaskSummaryV1 {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  blockedBy: readonly string[]
}
export interface PiHarnessTaskStateSummaryV1 {
  revision: number
  tasks: readonly PiHarnessTaskSummaryV1[]
}
export type PiHarnessGoalStatusV1 = 'active' | 'complete' | 'blocked' | 'cancelled' | 'budget_exhausted'
export interface PiHarnessGoalSummaryV1 {
  id: string
  revision: number
  status: PiHarnessGoalStatusV1
  source: 'user' | 'agent' | 'automation'
  creator: string
  condition: string
  budgets: {
    turnLimit: number
    tokenLimit: number
    costLimitUsd: number
    elapsedLimitMs: number
  }
  accounting: {
    turns: number
    tokens: number
    costUsd: number
    elapsedMs: number
    resumeCount: number
  }
  blocking?: { condition: string; blockedBy: 'user' | 'external'; consecutive: number }
  lastEvaluation?: {
    source: 'manual' | 'evaluator' | 'budget'
    verdict: 'not_complete' | 'complete_suggested' | 'completed' | 'blocked' | 'cancelled' | 'budget_exhausted' | 'resumed'
    reason: string
    evidence: readonly string[]
    evaluatedAt: number
  }
  createdAt: number
  updatedAt: number
}
export interface PiHarnessPendingAskQuestionSummaryV1 {
  question: string
  header?: string
  options: readonly { label: string; description?: string }[]
  multiSelect: boolean
}
export interface PiHarnessPendingAskSummaryV1 {
  requestId: string
  question: string
  options: readonly string[]
  allowFreeText: boolean
  timeoutMs?: number
  /** Batched AskUserQuestion superset (R7); absent for legacy pendings. */
  questions?: readonly PiHarnessPendingAskQuestionSummaryV1[]
}
export type PiHarnessPlanSummaryV1 =
  | { kind: 'inactive'; revision: number }
  | { kind: 'planning'; revision: number; previousMode: PiHarnessPermissionModeV1 }
  | { kind: 'awaiting_user'; revision: number; previousMode: PiHarnessPermissionModeV1; submissionId: string; notificationDispatched: boolean }
/**
 * Mirrors `ThinkingLevel` (`shared/src/agent/thinking-levels.ts`
 * `THINKING_LEVEL_IDS`) as a wire literal, the way
 * {@link PiHarnessPermissionModeV1} mirrors `PermissionMode`. Declared here so
 * this package stays dependency-light; the two must move together.
 */
export type PiHarnessChildEffortV1 = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export interface PiHarnessChildSummaryV1 {
  agentId: string
  ownerTaskId?: string
  backgroundTaskId?: string
  worktreeLeaseId?: string
  agent: string
  /**
   * The task the child was started with. Carried so a panel row can tell two
   * forks apart — `sub-agents.md:1023` puts "one row for the main session and
   * one for each fork" below the prompt, and `agent`/`status` alone repeat.
   */
  task?: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  background: boolean
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  error?: string
  /**
   * The reasoning effort this child is RUNNING at, and the model it runs on.
   *
   * `statusline.md` § `subagentStatusLine` gives the per-subagent row body an
   * `effort` — "the reasoning effort set for that subagent, in its definition
   * frontmatter or on the individual invocation" — alongside `model`. Both
   * values already exist host-side: the spawner resolves the effort by that
   * precedence (`spawner.ts` `effectiveThinkingLevel`) onto the REQUIRED
   * `PiChildRestrictionsV1.thinkingLevel`, and the host clones the restrictions
   * onto its child record. They stopped one step short of the panel; this is
   * that step.
   *
   * APPLIED, NOT CONFIGURED — a deliberate divergence from the page. The page
   * "reports the configured value as written: if the model doesn't support that
   * level, the effort Claude Code actually applies may differ." Our
   * `thinkingLevel` has already been clamped to the child's own model
   * (`clampThinkingLevelToModel`), and the pre-clamp value is not carried
   * anywhere the host can read. A row whose purpose is telling the user what
   * RAN must not report a level that did not run, so the clamped value is what
   * ships and no second field was invented to hold the other one.
   *
   * WIRE: appended LAST, and both optional — a summary from a host that
   * predates them must keep parsing and must render exactly as before.
   */
  effort?: PiHarnessChildEffortV1
  model?: string
}
export interface PiHarnessChildStateSummaryV1 {
  revision: number
  sealedOwnerTaskIds: readonly string[]
  children: readonly PiHarnessChildSummaryV1[]
}
export interface PiHarnessMailboxSummaryV1 { revision: number; messageCount: number }
export interface PiHarnessWorktreeSummaryV1 {
  worktreeLeaseId: string
  ownerAgentId: string
  branch: string
  status: 'creating' | 'active'
}
export type PiHarnessLspHealthV1 =
  | { status: 'unavailable'; reason: string }
  | { status: 'connecting' }
  | { status: 'ready' }
  | { status: 'failed'; reason: string }
export interface PiHarnessMcpHealthV1 {
  status: 'unavailable' | 'ready' | 'degraded'
  connected: readonly string[]
  failed: readonly string[]
}
export interface PiHarnessContextSummaryV1 {
  capabilityGeneration?: string
  sourceCount: number
  skillCount: number
  mcpServerCount: number
  hookCount: number
  promptLayerCount: number
  memoryCount: number
  inputTokens?: number | null
  contextWindow?: number | null
  percent?: number | null
  stale?: boolean
}
export interface PiHarnessCompactionSummaryV1 {
  isCompacting: boolean
  autoCompactionEnabled?: boolean | null
  remainingBeforeAutoCompact?: number | null
  pendingPlan: boolean
}
export interface PiHarnessCheckpointSummaryV1 {
  id: string
  adapter: 'file'
  toolName: string
  fileName: string
  existed: boolean
  preimageDigest?: string
  postimageDigest?: string
  currentDigest?: string
  postimageExists?: boolean
  currentExists: boolean
  outcome?: 'applied' | 'no-op' | 'failed'
  changed?: boolean
  conflict: boolean
  createdAt: string
  completedAt?: string
  revertedAt?: string
}
export interface PiHarnessPendingPermissionSummaryV1 {
  requestId: string
  type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval' | 'workflow_launch' | 'worktree_approval' | 'worktree_setup' | 'worktree_cleanup' | 'ask_user' | 'outside_root' | 'permission_dsl'
  /**
   * The child agent that asked, when the request belongs to a registered child
   * of this session rather than to the session itself (`sub-agents.md:1043`).
   * Absent for the session's own prompts, so a reader can tell "this session
   * needs an answer" from "a fork of this session needs one" without a second
   * lookup — and can name the fork instead of asking about an anonymous write.
   */
  agentId?: string
  source: 'session-permission'
}
export interface PiHarnessFilesystemRootSummaryV1 {
  receiptId: string
  canonicalRoot: string
  access: 'read' | 'write'
  expires: 'request' | 'session'
}
/** Safe project config diagnostic: code only, never the raw message/paths. */
export interface PiHarnessProjectConfigDiagnosticV1 {
  severity: 'error' | 'warning'
  code: string
}
/** P6: safe session filesystem scope view (no secrets, no plugin paths). */
export interface PiHarnessFilesystemScopeSummaryV1 {
  primaryRoot: string
  hasProject: boolean
  additionalRoots: readonly PiHarnessFilesystemRootSummaryV1[]
  configDiagnostics?: readonly PiHarnessProjectConfigDiagnosticV1[]
}
/**
 * The Pi runtime's security summary — WIRE-LIVE, DISPLAY-DEAD (P2.364).
 *
 * This block never reaches a user. Its only renderer was
 * `apps/electron/src/renderer/components/right-sidebar/PiRuntimeControlCenter.tsx`,
 * which read every field here through `chat.piRuntime.*` labels. `de5481f9`
 * removed that component's only mount (SessionFilesSection's Info popover)
 * because the unified MCP panel had replaced its surfaces, and `79eb19879`
 * (2026-07-31, *"drop the unmounted PiAgentView and PiRuntimeControlCenter"*)
 * deleted the component. **The 48 `chat.piRuntime.*` locale keys outlived it by
 * a month and shipped in every renderer bundle**; P2.364 removed them, and
 * `packages/shared/src/i18n/__tests__/pi-runtime-control-center-keys.test.ts`
 * is the gate that keeps them gone.
 *
 * The block itself is NOT dead, which is why it stayed:
 * - `pendingPermissions` is read by the live-test rig on every run
 *   (`scripts/cdp/lib/state.ts`, `scripts/cdp/cases/rts-10.ts`) — it is the only
 *   read that tells "the card on screen was already answered" from "a second,
 *   genuinely pending request", so deleting it blinds RTS-10.
 * - `risk` and `filesystemScope` are pinned by contract tests
 *   (`SessionManager.pi-runtime-snapshot.test.ts`,
 *   `__tests__/filesystem-scope-revocation.test.ts`,
 *   `packages/shared/src/protocol/pi-harness-runtime.test.ts`).
 * - `permissionMode`, `contextProfile`, `projectTrustState`, `permissionSource`,
 *   `isolationProfiles` and `hookCount` have no reader at all beyond the strict
 *   `exact()` validator in `packages/shared/src/protocol/pi-harness-runtime.ts`.
 *
 * Nothing here feeds a product decision: the snapshot is built read-only from
 * already-decided state and no production branch reads it. Enforcement lives at
 * the permission and filesystem-scope layers, not on this projection.
 *
 * **Do not add a new diagnostic carrier here.** P2.276 proposed exactly that,
 * beside `filesystemScope.configDiagnostics`, and it would have landed a field
 * with no reader inside a block with no renderer. Use a channel that has
 * consumers — the session `info`/`warning` event, as P2.276 finally did.
 */
export interface PiHarnessSecuritySummaryV1 {
  permissionMode?: PiHarnessPermissionModeV1
  contextProfile?: 'normal' | 'bare'
  projectTrustState: 'none' | 'trusted' | 'blocked'
  risk: 'none' | 'pending-approval'
  permissionSource: 'session-mode'
  pendingPermissions: readonly PiHarnessPendingPermissionSummaryV1[]
  isolationProfiles: readonly string[]
  hookCount: number
  filesystemScope?: PiHarnessFilesystemScopeSummaryV1
}

export type PiHarnessExecutionOutcomeV1 = 'success' | 'error' | 'denied' | 'cancelled' | 'timed-out'
export type PiHarnessToolEffectV1 = 'read' | 'workspaceMutation' | 'externalMutation' | 'unknown'
export interface PiHarnessExecutionReceiptSummaryV1 {
  sequence: number
  executionId: string
  semanticId: string
  outcome: PiHarnessExecutionOutcomeV1
  startedAt: number
  completedAt: number
  manifestGeneration: string
  responseEpoch: number
  effect: PiHarnessToolEffectV1
  isolationProfile: string
  environmentProfile?: 'restricted' | 'explicit' | 'trusted-host'
  environmentDigest?: string
  decisionId: string
  code?: string
  parentExecutionId?: string
  checkpointId?: string
  processId?: string
  childIds?: readonly string[]
  workflowId?: string
  goalId?: string
  goalRevision?: number
  mcpServer?: string
  mcpTool?: string
}

export type PiHarnessSettlementPendingDomainV1 =
  | 'foreground_model_turn' | 'workflow_evaluator' | 'child' | 'process'
  | 'permission' | 'ask_user' | 'immediate_task'
export interface PiHarnessSessionSettlementV1 {
  schemaVersion: 1
  settled: boolean
  pending: readonly PiHarnessSettlementPendingDomainV1[]
}

export interface PiHarnessRuntimeSnapshotV1 {
  schemaVersion: 1
  session: PiHarnessSessionRefV1
  provider: PiHarnessProviderV1
  available: boolean
  unavailableReason?: 'provider-not-pi' | 'pi-runtime-not-started'
  generatedAt: number
  manifest?: PiHarnessManifestDiagnosticsV1
  taskState?: PiHarnessTaskStateSummaryV1
  goal?: PiHarnessGoalSummaryV1
  pendingAsk?: PiHarnessPendingAskSummaryV1
  planState?: PiHarnessPlanSummaryV1
  childState?: PiHarnessChildStateSummaryV1
  mailbox?: PiHarnessMailboxSummaryV1
  worktrees: readonly PiHarnessWorktreeSummaryV1[]
  lspHealth?: PiHarnessLspHealthV1
  mcpHealth?: PiHarnessMcpHealthV1
  context: PiHarnessContextSummaryV1
  compaction: PiHarnessCompactionSummaryV1
  security: PiHarnessSecuritySummaryV1
  settlement: PiHarnessSessionSettlementV1
  executionReceipts: readonly PiHarnessExecutionReceiptSummaryV1[]
  checkpoints: readonly PiHarnessCheckpointSummaryV1[]
  processes: readonly PiHarnessProcessSnapshotV1[]
}

export interface PiHarnessRuntimeEventV1 {
  schemaVersion: 1
  session: PiHarnessSessionRefV1
  changedDomains: readonly PiHarnessRuntimeDomainV1[]
}
export interface PiHarnessRuntimeSnapshotResultV1 { snapshot: PiHarnessRuntimeSnapshotV1; barrierSeq: number }

interface PiHarnessRuntimeControlBaseV1 { schemaVersion: 1; session: PiHarnessSessionRefV1 }
export type PiHarnessRuntimeControlRequestV1 =
  | (PiHarnessRuntimeControlBaseV1 & { action: 'refresh' })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'stop_process'; handle: string })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'read_process'; handle: string; cursor?: number })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'read_child'; agentId: string; cursor?: number })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'stop_child'; agentId: string })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'steer_child'; agentId: string; message: string })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'answer_ask'; requestId: string; answer: AskUserAnswer })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'cancel_ask'; requestId: string })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'approve_plan' })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'exit_plan' })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'release_worktree'; leaseId: string })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'rewind_checkpoint'; checkpointId: string })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'goal_create'; condition: string; budgets?: Partial<{ turnLimit: number; tokenLimit: number; costLimitUsd: number; elapsedLimitMs: number }> })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'goal_replace'; goalId: string; revision: number; condition: string; budgets?: Partial<{ turnLimit: number; tokenLimit: number; costLimitUsd: number; elapsedLimitMs: number }> })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'goal_cancel'; goalId: string; revision: number; reason: string })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'goal_complete'; goalId: string; revision: number; reason: string; evidence: readonly string[] })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'goal_blocked'; goalId: string; revision: number; blockingCondition: string; blockedBy: 'user' | 'external'; reason: string; evidence: readonly string[] })
  | (PiHarnessRuntimeControlBaseV1 & { action: 'goal_resume'; goalId: string; revision: number; reason: string })

export interface PiHarnessRuntimeControlResultV1 {
  schemaVersion: 1
  ok: boolean
  output?: string
  nextCursor?: number
  error?: string
}

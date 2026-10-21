import { createHash } from 'node:crypto'

import { managedModelAllowlist } from '../../config/managed-model-allowlist.ts'
import { resolveMaxBudgetTokens } from '../../config/max-budget-tokens.ts'
import { DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH } from '../../config/subagent-spawn-depth.ts'
import {
  resolveDeferredMcpToolLoading,
  type ToolSearchMode,
} from '../../config/tool-search-settings.ts'
import { estimateTokens } from '../../utils/large-response.ts'
import type { SessionKey } from '../../sessions/session-key.ts'
import type { AgentRuntimeView } from '../../capabilities/views.ts'
import type { EffectiveCapabilitySnapshot } from '../../capabilities/resolver.ts'
import {
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
  getPiToolBindingByBindingName,
  getPiStaticModelContractHash,
  type HarnessToolDescriptor,
  type PiToolBinding,
} from './harness-tool-descriptor.ts'

export const PI_EXECUTION_MANIFEST_VERSION = 2 as const
/**
 * The COUNT threshold. Deliberately not re-expressed as Claude's context
 * percentage: see the second contract point in `config/tool-search-settings.ts`.
 *
 * ITS SCOPE NARROWED when deferral became the default. It no longer governs the
 * unset case — the `(unset)` row consults no count — and now serves exactly one
 * arm: `auto` on a model whose context window we do not know, where a count is
 * the only threshold left to compute. Still live, much smaller.
 */
export const PI_DEFERRED_MCP_TOOL_THRESHOLD = 48

export interface PiOrchestratorConfig {
  concurrency: number
  depth: number
  maxParallelTasks: number
  maxAgents: number
  tierModelMap: Partial<Record<'small' | 'medium' | 'big', string>> | null
  tokenBudget: number | null
  /**
   * Host-materialized stable prose context for child sessions (S1). Built once
   * per session from stable workspace info (workspace root, project summary) —
   * never volatile turn state or the parent transcript. The spawner inserts it
   * between the safety core and the agent system prompt. Omitted when absent so
   * legacy manifests keep their canonical hash.
   */
  contextSeed?: string
  /**
   * This session's own child-session depth (0 = top-level session). Lets the
   * subprocess orchestrator tools distinguish top-level from nested spawns.
   * Omitted when 0 so legacy manifests keep their canonical hash.
   */
  sessionDepth?: number
  /**
   * This session IS a conversation fork. sub-agents.md:1052 — "A fork can't
   * spawn further forks" — and that rule is unconditional, not depth-dependent,
   * so the subprocess spawner needs the fact independently of `sessionDepth`.
   *
   * Carried on the orchestrator config rather than a bare init field because the
   * manifest validator asserts host and subprocess agree on this object, so the
   * two sides cannot drift. Omitted when false so legacy manifests keep their
   * canonical hash.
   */
  sessionIsFork?: true
  /**
   * FORK MODE for this session (`NESSY_FORK_SUBAGENT`, sub-agents.md:1006).
   * Distinct from `sessionIsFork`: that says "this session IS a fork", this says
   * "this session MAY spawn one".
   *
   * It has to travel with the manifest rather than being read from the
   * subprocess environment, because `:783` makes fork mode change the `subagent`
   * tool's PARAMETER SCHEMA, and the schema is hashed into
   * `modelContractHash`. A subprocess resolving the flag independently could
   * disagree with the host and fail every turn with "Pi execution manifest model
   * contract mismatch". Omitted when off so legacy manifests keep their
   * canonical hash.
   */
  forkSubagent?: true
  /**
   * The managed model allowlist (`settings-reference.md#availablemodels`), as
   * it applies to the DELEGATED tiers: "Restrict which models people can select
   * for the main session, subagents, skills, and the advisor."
   *
   * `model-config.md:154` names the subagent inputs by hand — "the `model` field
   * in subagent frontmatter, the Agent tool's `model` parameter" — and both are
   * resolved inside the Pi subprocess (`orchestrator/spawner.ts`), where the
   * host's process-wide policy registry does not reach. It travels on the signed
   * manifest for the same reason `forkSubagent` does: the two sides must not be
   * able to disagree about it, and the manifest is the object they already
   * validate against each other.
   *
   * Absent = no narrowing. An EMPTY array is a real value and is NOT omitted:
   * `managed-settings.md#keys-that-fail-closed`'s `availableModels` row reads it
   * as "Enforced as an empty allowlist until fixed, so only the Default model is
   * available", so a subprocess that mistook `[]` for "unset" would grant
   * exactly what the policy refuses.
   */
  availableModels?: readonly string[]
}

// Claude-Code-class orchestrator defaults (T1). `concurrency` is the ceiling of
// the effective parallel-children clamp — the pi-agent-server spawner narrows it
// to `min(concurrency, cpuCores - 2)` at runtime (host-side `shared` has no `os`
// access, so the OS-dependent clamp lives in the subprocess where it belongs;
// keeping the ceiling machine-independent keeps the execution-manifest config
// deterministic). Explicit init/config values still win.
export const DEFAULT_PI_ORCHESTRATOR_CONFIG: Readonly<PiOrchestratorConfig> = Object.freeze({
  concurrency: 16,
  // THREE subagent layers below the main conversation by default
  // (sub-agents.md:867, env-vars.md:281 "default: 3"). Kept in lockstep with
  // the spawner's `DEFAULT_MAX_DEPTH`; if they disagree, the higher one
  // silently wins as a fallback wherever the other is unset. This frozen
  // constant is the STATIC fallback only — the per-session env override
  // (`NESSY_MAX_SUBAGENT_SPAWN_DEPTH` / `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`)
  // is resolved host-side into the manifest seed by `SessionManager`.
  depth: DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH,
  maxParallelTasks: 100,
  maxAgents: 1000,
  tierModelMap: null,
  tokenBudget: null,
})

export type PiCapabilitySourceRef =
  | { kind: 'piBuiltin'; bindingId: string }
  | { kind: 'resolvedCapability'; capabilityKey: string; generation: string }

export interface ResolvedHarnessTool {
  descriptor: HarnessToolDescriptor
  binding: PiToolBinding
  source: PiCapabilitySourceRef
  description?: string
  modelSchema?: Record<string, unknown>
  promptSnippet?: string
  promptGuidelines?: readonly string[]
  modelContractHash?: string
}

export interface PiExecutionManifestSeedV2 {
  surfaceVersion: typeof PI_EXECUTION_MANIFEST_VERSION
  snapshotGeneration: string
  sessionKey: SessionKey
  provenance: readonly { capabilityKey: string; generation: string }[]
  mcpSources: readonly { wireName: string; capabilityKey: string; generation: string }[]
  orchestrator: PiOrchestratorConfig
  staticTools: readonly ResolvedHarnessTool[]
}

export interface PiExecutionManifestV2 {
  surfaceVersion: typeof PI_EXECUTION_MANIFEST_VERSION
  snapshotGeneration: string
  sessionKey: SessionKey
  provenance: readonly { capabilityKey: string; generation: string }[]
  mcpSources: readonly { wireName: string; capabilityKey: string; generation: string }[]
  orchestrator: PiOrchestratorConfig
  deferredMcp: {
    enabled: boolean
    candidatePiNames: readonly string[]
  }
  tools: readonly ResolvedHarnessTool[]
  manifestHash: string
}

export interface PiDynamicToolDefinition {
  bindingName: string
  description: string
  inputSchema: Record<string, unknown> | undefined
  promptSnippet?: string
  promptGuidelines?: readonly string[]
  modelSchemaVersion: number
  bindingSchemaVersion: number
  provenance: { capabilityKey: string; generation: string }
  /**
   * Pinned past deferred tool loading: the tool stays registered and is excluded
   * from `deferredMcp.candidatePiNames`. Set from a server's `alwaysLoad` config
   * or a tool's own `_meta["anthropic/alwaysLoad"]`. NOT part of the manifest
   * projection — it only steers the candidate list, so it cannot move the
   * manifest hash on its own.
   */
  alwaysLoad?: boolean
}

const STATIC_CHILD_BINDINGS = new Set([
  'read', 'bash', 'bash_background', 'edit', 'write', 'grep', 'find', 'ls', 'NotebookEdit',
  'web_search', 'web_fetch', 'subagent', 'review', 'get_subagent_result', 'steer_subagent', 'stopTask', 'workflow', 'ask_user',
  'mcp__tool_search', 'mcp__tool_load',
])

/**
 * The built-ins that load ON DEMAND — everything in {@link STATIC_CHILD_BINDINGS}
 * that is not core.
 *
 * `agent-sdk/tool-search.md`: "The SDK always loads core built-in tools such as
 * Bash, Read, and Edit upfront and doesn't count them toward the threshold",
 * and the threshold's denominator is "each MCP tool that isn't marked
 * `alwaysLoad`, from any server, plus the built-in tools that load on demand".
 * So this set is BOTH the deferral candidates and the part of the count C9
 * verified we were already computing narrowly — adding them here is what makes
 * our denominator match the sentence rather than only its first half.
 *
 * The complement is deliberate and is the safety argument: `read`, `bash`,
 * `edit`, `write`, `grep`, `find`, `ls` are the core seven the page names by
 * example; `subagent` and `ask_user` stay resident because a session that has
 * to SEARCH for how to ask its user is a worse session; `review` stays resident
 * for /code-review's own turn (F1.728); the two discovery tools cannot defer.
 *
 * Spelled as bindingNames, which is what {@link STATIC_CHILD_BINDINGS} uses and
 * what a tool DEFINITION is keyed by. Two entries here have a different
 * `piName` — `NotebookEdit`/`notebook_edit` and `stopTask`/`stop_task` — and
 * that divergence is load-bearing downstream: the model-visible catalogue is
 * keyed by piName while definitions are keyed by bindingName, so anything
 * matching one against the other silently handles six of these eight.
 */
export const PI_DEFERRABLE_BUILTIN_BINDINGS: ReadonlySet<string> = Object.freeze(new Set([
  'NotebookEdit', 'web_search', 'web_fetch',
  'get_subagent_result', 'steer_subagent', 'stopTask', 'workflow', 'bash_background',
]))

/**
 * The session tools that stay UPFRONT. C5's list is written as a keep-list
 * rather than a defer-list on purpose: there are 55 session bindings and the
 * set grows, so a defer-list would silently leave every new tool loaded while a
 * keep-list leaves every new tool deferred — the safer default now that
 * deferral ships on.
 *
 * The rule, so it can be argued with rather than guessed at: a session tool
 * stays upfront when the TURN'S OWN CONTROL FLOW needs it — submitting a plan,
 * tracking todos and tasks, goals, memory, and reporting a review's verdict
 * (F1.728). Everything else is reached because the user asked for that thing
 * specifically, which is exactly the case `mcp__tool_search` serves.
 *
 * This mirrors what `agent-sdk/tool-search.md` says about built-ins ("always
 * loads core built-in tools such as Bash, Read, and Edit upfront"), applied to
 * the session surface: core means "used without being asked", not "important".
 *
 * Deferring is not removing. A deferred tool is in the signed manifest, findable
 * by search and callable once loaded; the cost of getting an entry wrong here is
 * one extra round-trip, not a missing capability.
 */
export const PI_UPFRONT_SESSION_BINDINGS: ReadonlySet<string> = Object.freeze(new Set([
  'mcp__session__SubmitPlan',
  'mcp__session__TodoWrite',
  'mcp__session__Task',
  'mcp__session__TaskCreate',
  'mcp__session__TaskUpdate',
  'mcp__session__TaskGet',
  'mcp__session__TaskList',
  'mcp__session__Goal',
  'mcp__session__GoalGet',
  'mcp__session__remember',
  'mcp__session__ReportFindings',
]))

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`Invalid ${field}: expected a positive integer`)
  }
  return value as number
}

const MAX_PI_ORCHESTRATOR_CONTEXT_SEED_LENGTH = 16_384

function normalizeContextSeed(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string') {
    throw new Error('Invalid orchestrator.contextSeed: expected a string')
  }
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > MAX_PI_ORCHESTRATOR_CONTEXT_SEED_LENGTH) {
    throw new Error(`Invalid orchestrator.contextSeed: exceeds ${MAX_PI_ORCHESTRATOR_CONTEXT_SEED_LENGTH} characters`)
  }
  return trimmed
}

function normalizeSessionDepth(value: unknown): number | undefined {
  if (value == null || value === 0) return undefined
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error('Invalid orchestrator.sessionDepth: expected a non-negative integer')
  }
  return value as number
}

const MAX_MANAGED_MODEL_ENTRIES = 128, MAX_MANAGED_MODEL_ENTRY_LENGTH = 256

/**
 * `undefined` when the key is absent, the list verbatim otherwise — including
 * the empty list, which is a different policy from an absent one. Order is the
 * administrator's and is preserved, because `model-config.md:220` resolves the
 * enforced Default to "the first `availableModels` entry that is available".
 */
function normalizeManagedModels(value: unknown): readonly string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length > MAX_MANAGED_MODEL_ENTRIES) {
    throw new Error('Invalid orchestrator.availableModels')
  }
  for (const entry of value) {
    if (typeof entry !== 'string'
      || entry.length === 0
      || entry.length > MAX_MANAGED_MODEL_ENTRY_LENGTH) {
      throw new Error('Invalid orchestrator.availableModels entry')
    }
  }
  return Object.freeze([...value as string[]])
}

export function normalizePiOrchestratorConfig(input: Partial<PiOrchestratorConfig> | undefined): PiOrchestratorConfig {
  const value = { ...DEFAULT_PI_ORCHESTRATOR_CONFIG, ...input }
  const tierModelMap = value.tierModelMap == null
    ? null
    : Object.fromEntries(Object.entries(value.tierModelMap).map(([tier, model]) => {
        if (!['small', 'medium', 'big'].includes(tier) || typeof model !== 'string' || model.length === 0) {
          throw new Error(`Invalid orchestrator.tierModelMap.${tier}`)
        }
        return [tier, model]
      })) as PiOrchestratorConfig['tierModelMap']
  const tokenBudget = value.tokenBudget == null
    ? null
    : positiveInteger(value.tokenBudget, 'orchestrator.tokenBudget')
  const contextSeed = normalizeContextSeed(value.contextSeed)
  const sessionDepth = normalizeSessionDepth(value.sessionDepth)
  const availableModels = normalizeManagedModels(value.availableModels)
  return {
    concurrency: positiveInteger(value.concurrency, 'orchestrator.concurrency'),
    depth: positiveInteger(value.depth, 'orchestrator.depth'),
    maxParallelTasks: positiveInteger(value.maxParallelTasks, 'orchestrator.maxParallelTasks'),
    maxAgents: positiveInteger(value.maxAgents, 'orchestrator.maxAgents'),
    tierModelMap,
    tokenBudget,
    ...(contextSeed === undefined ? {} : { contextSeed }),
    ...(sessionDepth === undefined ? {} : { sessionDepth }),
    ...(value.sessionIsFork === true ? { sessionIsFork: true as const } : {}),
    ...(value.forkSubagent === true ? { forkSubagent: true as const } : {}),
    ...(availableModels === undefined ? {} : { availableModels }),
  }
}

/**
 * Flatten one interpolated fact onto a single line: strip control characters
 * (newlines, tabs, carriage returns) and collapse any remaining whitespace runs
 * to a single space, then trim. A newline-bearing workspace name would otherwise
 * inject its own bullet/prose lines between the safety core and the agent prompt.
 */
function sanitizeContextSeedFact(value: string): string {
  // Drop C0/DEL control characters (incl. newline, tab, CR) then collapse any
  // remaining whitespace runs to a single space so the fact stays one line.
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Materialize the stable child-session context seed on the HOST from stable
 * workspace info only (workspace identity, workspace root, working directory).
 * Never include volatile turn state or parent transcript content — the block
 * must stay byte-identical across capability-runtime rebuilds within a session
 * so the execution-manifest hash stays stable. Each interpolated fact is
 * flattened to a single line so a newline-bearing workspace name cannot inject
 * extra lines into the composed child prompt.
 */
export function buildPiOrchestratorContextSeed(input: {
  workspaceName?: string
  workspaceRootPath?: string
  workingDirectory?: string
}): string | undefined {
  const workspaceName = sanitizeContextSeedFact(input.workspaceName ?? '')
  const workspaceRootPath = sanitizeContextSeedFact(input.workspaceRootPath ?? '')
  const workingDirectory = sanitizeContextSeedFact(input.workingDirectory ?? '')
  const facts = [
    ...(workspaceName ? [`- Workspace: ${workspaceName}`] : []),
    ...(workspaceRootPath ? [`- Workspace root: ${workspaceRootPath}`] : []),
    ...(workingDirectory ? [`- Working directory: ${workingDirectory}`] : []),
  ]
  if (facts.length === 0) return undefined
  return [
    '## Parent Workspace Context',
    'You are a subagent working inside the parent session\'s workspace.',
    ...facts,
  ].join('\n')
}

/**
 * sub-agents.md:783 — "fork mode removes the `run_in_background` parameter from
 * the `Agent` tool" — so the `subagent` tool has TWO model-visible shapes and
 * therefore two pinned contract hashes. Both sides derive the variant from the
 * same manifest field, which is what keeps them from disagreeing.
 */
export function piStaticModelContractPinKey(bindingName: string, orchestrator: PiOrchestratorConfig): string {
  return bindingName === 'subagent' && orchestrator.forkSubagent === true
    ? 'subagent:fork-mode'
    : bindingName
}

function staticTools(orchestrator: PiOrchestratorConfig): ResolvedHarnessTool[] {
  return PI_TOOL_BINDINGS
    .filter(value => STATIC_CHILD_BINDINGS.has(value.bindingName))
    .map(binding => ({
      descriptor: getHarnessToolDescriptor(binding.descriptorId),
      binding,
      source: { kind: 'piBuiltin', bindingId: binding.bindingName },
      modelContractHash: getPiStaticModelContractHash(piStaticModelContractPinKey(binding.bindingName, orchestrator)),
    }))
}

function descriptorPromptGuidelines(descriptor: HarnessToolDescriptor): readonly string[] {
  return Object.freeze([
    `Effect: ${descriptor.effect}.`,
    `Scheduling: ${descriptor.scheduling}.`,
  ])
}

export function derivePiPromptMetadata(input: {
  bindingName: string
  description: string
  descriptor: HarnessToolDescriptor
}): { promptSnippet?: string; promptGuidelines: readonly string[] } {
  const contextual = /^(?:mcp__session__)?source_(?:google_)?oauth_trigger$/.test(input.bindingName)
  return {
    ...(contextual ? {} : {
      promptSnippet: input.description.length > 200
        ? `${input.description.slice(0, 197)}...`
        : input.description,
    }),
    promptGuidelines: descriptorPromptGuidelines(input.descriptor),
  }
}

export function createPiExecutionManifestSeed(input: {
  snapshot: EffectiveCapabilitySnapshot
  view: AgentRuntimeView
  sessionKey: SessionKey
  orchestrator?: Partial<PiOrchestratorConfig>
  /**
   * N2 — a residual wireName collision (e.g. a marketplace plugin's MCP
   * server named like a built-in dp server) must degrade one duplicate
   * entry, not fail the whole seed. Optional sink for that diagnostic;
   * callers with no logger simply get silent dedup.
   */
  debug?: (message: string) => void
}): PiExecutionManifestSeedV2 {
  if (input.snapshot.generation !== input.view.generation) {
    throw new Error('Pi execution manifest seed generation mismatch')
  }
  if (input.snapshot.context.workspaceId !== input.sessionKey.workspaceId
    || input.snapshot.context.sessionId !== input.sessionKey.sessionId) {
    throw new Error('Pi execution manifest seed SessionKey mismatch')
  }
  const viewKeys = new Set([
    ...input.view.sources, ...input.view.skills, ...input.view.mcpServers,
    ...input.view.hooks, ...input.view.automations, ...input.view.agents,
    ...input.view.promptLayers, ...input.view.memory, ...input.view.permissionLayers,
    ...input.view.commands, ...input.view.apps,
  ].map(value => value.key))
  const provenance = input.snapshot.entries
    .filter(entry => viewKeys.has(entry.summary.key))
    .map(entry => ({ capabilityKey: entry.summary.key, generation: input.snapshot.generation }))
    .sort((a, b) => a.capabilityKey.localeCompare(b.capabilityKey))
  // N2: a plugin MCP server can collide by wireName with a built-in or
  // another plugin's server. Rather than fail the whole seed (and every turn
  // with it — the field incident this guards against), keep one deterministic
  // winner per wireName and let the caller log the rest. Sorting by
  // capabilityKey before dedup, not just wireName, is what makes the winner
  // deterministic instead of source-array-order-dependent.
  const sorted = [
    ...input.view.sources
      .filter(source => source.mcpWireName)
      .map(source => ({ wireName: source.mcpWireName!, capabilityKey: source.key, generation: input.view.generation })),
    ...input.view.mcpServers
      .map(server => ({ wireName: server.wireName, capabilityKey: server.key, generation: input.view.generation })),
  ]
    .sort((a, b) => a.wireName.localeCompare(b.wireName) || a.capabilityKey.localeCompare(b.capabilityKey))
  const byWire = new Map<string, typeof sorted[number]>()
  for (const source of sorted) {
    const existing = byWire.get(source.wireName)
    if (!existing) { byWire.set(source.wireName, source); continue }
    input.debug?.(`pi-manifest: duplicate MCP wireName "${source.wireName}" — keeping ${existing.capabilityKey}, dropping ${source.capabilityKey}`)
  }
  const mcpSources = [...byWire.values()]
  // The managed allowlist is HOST-resolved, and the host is this process — the
  // seed is built by `SessionManager` on the same side that composed the policy
  // at bootstrap. Read here rather than at the (single) call site so a second
  // call site cannot ship a manifest that forgets it; an explicit
  // `orchestrator.availableModels` still wins, which is the test seam.
  const managedModels = input.orchestrator?.availableModels ?? managedModelAllowlist()
  // P6.645 — the host's session token ceiling reaches the CHILD here, read the
  // same way and for the same reason `managedModels` above is: the spawner
  // already passes `budgets.tokenLimit: cfg.tokenBudget ?? 100_000` to every
  // child it admits, so the only thing missing was the host's number arriving.
  // Read here rather than at the call site so a second call site cannot ship a
  // manifest that forgets it.
  //
  // An explicit `orchestrator.tokenBudget` still wins — that is the workflow
  // author's own per-run budget (`workflow-tool.ts`), a deliberate choice, and
  // the same precedence `maxAgentTurns` uses between a configured value and an
  // environment default. With the cap off (the default) this resolves to 0 and
  // the field stays `null`, so the manifest is byte-identical to before.
  const hostTokenBudget = resolveMaxBudgetTokens()
  const orchestrator = normalizePiOrchestratorConfig({
    ...input.orchestrator,
    ...(input.orchestrator?.tokenBudget == null && hostTokenBudget > 0
      ? { tokenBudget: hostTokenBudget }
      : {}),
    ...(managedModels === undefined ? {} : { availableModels: managedModels }),
  })
  return deepFreeze({
    surfaceVersion: PI_EXECUTION_MANIFEST_VERSION,
    snapshotGeneration: input.snapshot.generation,
    sessionKey: { ...input.sessionKey },
    provenance,
    mcpSources,
    orchestrator,
    staticTools: staticTools(orchestrator),
  })
}

function resolveDynamicTool(seed: PiExecutionManifestSeedV2, input: PiDynamicToolDefinition): ResolvedHarnessTool | null {
  if (!input.inputSchema || typeof input.inputSchema !== 'object' || Array.isArray(input.inputSchema)) {
    throw new Error(`Pi execution manifest schema missing for ${input.bindingName}`)
  }
  if (input.modelSchemaVersion !== 1 || input.bindingSchemaVersion !== 1) {
    throw new Error(`Pi execution manifest schema version gap for ${input.bindingName}`)
  }
  if (input.provenance.generation !== seed.snapshotGeneration) {
    throw new Error(`Pi execution manifest dynamic provenance generation mismatch for ${input.bindingName}`)
  }
  const known = getPiToolBindingByBindingName(input.bindingName)
  const binding: PiToolBinding = known ?? {
    provider: 'pi',
    surfaceVersion: 2,
    piName: input.bindingName,
    modelSchemaVersion: 1,
    bindingName: input.bindingName,
    bindingSchemaVersion: 1,
    handlerName: input.bindingName,
    handlerSchemaVersion: 1,
    descriptorId: 'mcp_dynamic',
    permissionName: input.bindingName,
  }
  if (!known) {
    // N2: an unparseable name or a wireName that resolves zero or several
    // times in the seed drops this ONE tool instead of failing the whole
    // manifest (and with it, every turn of the session — the field
    // incident this guards against). The schema and provenance-capture
    // checks around this block are host-authored integrity checks and stay
    // fatal; only wire-name RESOLUTION degrades.
    const parsed = tryParsePiDynamicMcpBindingName(input.bindingName)
    if (!parsed) return null
    const sources = seed.mcpSources.filter(source => source.wireName === parsed.wireName)
    if (sources.length !== 1) return null
    const source = sources[0]!
    if (source.capabilityKey !== input.provenance.capabilityKey
      || source.generation !== input.provenance.generation
      || !seed.provenance.some(value => value.capabilityKey === source.capabilityKey
        && value.generation === source.generation)) {
      throw new Error(`Pi execution manifest dynamic provenance is not captured for ${input.bindingName}`)
    }
  }
  const descriptor = getHarnessToolDescriptor(binding.descriptorId)
  const source: PiCapabilitySourceRef = known
    ? { kind: 'piBuiltin', bindingId: binding.bindingName }
    : { kind: 'resolvedCapability', ...input.provenance }
  const prompt = input.promptSnippet === undefined && input.promptGuidelines === undefined
    ? derivePiPromptMetadata({ bindingName: input.bindingName, description: input.description, descriptor })
    : {
        ...(input.promptSnippet === undefined ? {} : { promptSnippet: input.promptSnippet }),
        promptGuidelines: Object.freeze([...(input.promptGuidelines ?? [])]),
      }
  const modelSchema = structuredClone(input.inputSchema)
  return {
    descriptor,
    binding,
    source,
    description: input.description,
    modelSchema,
    ...prompt,
  }
}

/** N2: the non-throwing twin `resolveDynamicTool` uses to degrade instead of fail the manifest. */
export function tryParsePiDynamicMcpBindingName(bindingName: string): { wireName: string; toolName: string } | null {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.exec(bindingName)
  if (!match) return null
  return { wireName: match[1]!, toolName: match[2]! }
}

export function parsePiDynamicMcpBindingName(bindingName: string): { wireName: string; toolName: string } {
  const parsed = tryParsePiDynamicMcpBindingName(bindingName)
  if (!parsed) throw new Error(`Unknown H2 Pi tool binding or invalid MCP wireName: ${bindingName}`)
  return parsed
}

/**
 * Estimated model-visible token cost of the deferrable candidates — the
 * numerator of Claude's `auto` rule, "the combined token count of all tool
 * definitions" (`tool-search.md:40`).
 *
 * Counts what the request actually carries per tool: the presented name, the
 * description and the model schema. Deliberately NOT the whole manifest entry —
 * descriptors, bindings and provenance never reach the model.
 *
 * It is an ESTIMATE (`estimateTokens`, 4 chars per token), not a tokenizer
 * count, and the threshold is therefore approximate on purpose. The cross-check
 * that it is fit for the arithmetic: our 51 session-tool definitions estimate to
 * 12,735 tokens, and `tool-search.md:13` puts 50 tools at "10-20K tokens".
 *
 * Deterministic in the candidate set alone, so it cannot make a model-visible
 * schema vary with anything else — the deferral decision changes which tools are
 * PRESENT, never any tool's shape.
 */
function estimateDeferredCandidateTokens(candidates: readonly ResolvedHarnessTool[]): number {
  let total = 0
  for (const tool of candidates) {
    total += estimateTokens(JSON.stringify({
      name: tool.binding.piName,
      description: tool.description,
      schema: tool.modelSchema,
    }))
  }
  return total
}

export function finalizePiExecutionManifest(
  seed: PiExecutionManifestSeedV2,
  dynamicTools: readonly PiDynamicToolDefinition[],
  options: {
    deferredMcpEnabled?: boolean
    allowedBindingNames?: readonly string[]
    /**
     * A desired MCP server contributes no tool descriptors yet — its tools are
     * neither connected nor cached. Such a server has nothing to advertise, so
     * without the discovery tools the turn would have no way to reach it at all.
     * This is therefore the one input that may enable discovery on its own,
     * independent of the workspace preference and the tool-count threshold:
     * it is not deferral by choice, it is the honest fallback for tools we
     * cannot list.
     */
    hasUncachedMcpSource?: boolean
    /**
     * The `disableWorkflows` off switch (`settings.md`, env, managed policy).
     *
     * It has to act HERE, on the signed manifest, not in the Pi subprocess:
     * `validateDefinitions` throws when a manifest tool has no runtime
     * definition, so a subprocess that merely skipped registering the tool
     * would abort session build instead of running without it. Removing the
     * tool from the manifest is also what makes the switch auditable — the
     * manifest hash changes, and no turn can reach a tool the manifest never
     * advertised.
     */
    disableWorkflows?: boolean
    /**
     * The `NESSY_DISABLE_BACKGROUND_TASKS` off switch (R10, `env-vars.md`
     * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`). Same reasoning as
     * `disableWorkflows`: it must act on the SIGNED manifest so a disabled
     * host never advertises `bash_background` and the subprocess never
     * registers a handler for it.
     */
    disableBackgroundTasks?: boolean
    /**
     * `NESSY_ENABLE_TOOL_SEARCH`, already parsed by the caller
     * (`config/tool-search-settings.ts`). Resolved on the HOST and carried
     * through the signed manifest rather than read from the subprocess
     * environment, for the same reason as every other manifest-shaping switch:
     * `deferredMcp.enabled` decides which tools the manifest advertises, and two
     * sides resolving it independently could disagree and fail every turn.
     */
    toolSearchMode?: ToolSearchMode
    /**
     * The active model's context window, for `auto`/`auto:N`. Absent when the
     * model is not in the catalog — arbitrary Nessy Gateway models often are
     * not (`model-fetchers/nestor.ts` leaves it unset when neither the API nor
     * the known-window table supplies one), so "unknown" is a normal state with
     * its own documented fallback, not an error.
     */
    modelContextWindow?: number
    /** F1.706 — where a dropped duplicate piName is reported, as the seed's N2 `debug`; absent = silent. */
    debug?: (message: string) => void
  } = {},
): PiExecutionManifestV2 {
  const allowed = options.allowedBindingNames ? new Set(options.allowedBindingNames) : undefined
  // N2: null = a wireName that doesn't resolve exactly once; F1.706: a later tool of a piName already kept. Each drops ONE tool, not the manifest (and every turn).
  const dynamic = dropLaterDuplicatePiNames(dynamicTools.map(value => resolveDynamicTool(seed, value))
    .filter((tool): tool is ResolvedHarnessTool => tool !== null)
    .filter(tool => !allowed || allowed.has(tool.binding.bindingName) || allowed.has(tool.binding.piName)), new Set(), options.debug)
  // A pinned tool is not deferrable, so it is neither a candidate nor part of the
  // count that decides whether there are too many DEFERRABLE tools for context.
  const pinnedNames = new Set(dynamicTools.filter(tool => tool.alwaysLoad === true).map(tool => tool.bindingName))
  // C7: the host's off switches are applied HERE, before deferral is considered,
  // and the deferrable built-ins are then derived from what survived. That
  // ordering is the fence the row asks for, made structural: `disableWorkflows`
  // and `NESSY_DISABLE_BACKGROUND_TASKS` REMOVE their tool from the signed
  // manifest, and a removed tool cannot become a deferral candidate because it
  // is no longer in the list the candidates are drawn from. An off switch and a
  // deferral are different states; this is what keeps them different without a
  // second rule someone has to remember.
  const availableStatic = seed.staticTools.filter(tool =>
    (!allowed || allowed.has(tool.binding.bindingName) || allowed.has(tool.binding.piName))
    && (options.disableWorkflows !== true || tool.binding.piName !== 'workflow')
    && (options.disableBackgroundTasks !== true || tool.binding.piName !== 'bash_background'))
  const deferredCandidates = [
    ...dynamic.filter(tool => (
      tool.source.kind === 'resolvedCapability' && !pinnedNames.has(tool.binding.bindingName)
    )),
    ...availableStatic.filter(tool => PI_DEFERRABLE_BUILTIN_BINDINGS.has(tool.binding.bindingName)),
    // C5. Session tools arrive through `dynamic` but resolve to `piBuiltin`
    // because they ARE known bindings — 55 of the 77 in `PI_TOOL_BINDINGS` —
    // so the `resolvedCapability` branch above never sees them. This admits
    // them by the same allowlist shape C7 proved, with no change of source
    // kind and therefore none of the permission/hook/catalogue blast radius
    // the row was parked for.
    ...dynamic.filter(tool => (
      tool.source.kind === 'piBuiltin'
      && tool.binding.bindingName.startsWith('mcp__session__')
      && !PI_UPFRONT_SESSION_BINDINGS.has(tool.binding.bindingName)
      && !pinnedNames.has(tool.binding.bindingName)
    )),
  ]
  const discoveryNames = new Set(['mcp__tool_search', 'mcp__tool_load'])
  // UB12.9: deferral needs BOTH halves of its loader in this manifest. A
  // whole-tool deny (`ToolSearch` binds both since F1.1111) or a narrowed pool
  // that removed either one turns deferral off, so the candidates load upfront
  // instead of hiding behind a loader the session no longer has.
  const loaderAvailable = [...discoveryNames].every(name => availableStatic.some(tool => tool.binding.piName === name))
  const deferredEnabled = resolveDeferredMcpToolLoading({
    loaderAvailable,
    mode: options.toolSearchMode ?? { kind: 'default' },
    workspacePreference: options.deferredMcpEnabled === true,
    hasUncachedMcpSource: options.hasUncachedMcpSource === true,
    candidateCount: deferredCandidates.length,
    candidateEstimatedTokens: estimateDeferredCandidateTokens(deferredCandidates),
    countThreshold: PI_DEFERRED_MCP_TOOL_THRESHOLD,
    ...(options.modelContextWindow === undefined ? {} : { modelContextWindow: options.modelContextWindow }),
  }).enabled
  // Only the discovery pair depends on the decision, and neither of them is a
  // deferrable built-in — which is why the candidate set above could be computed
  // before `deferredEnabled` without circularity.
  const staticTools = availableStatic.filter(tool =>
    deferredEnabled || !discoveryNames.has(tool.binding.piName))
  // F1.706: two HOST tools sharing a name is a host-authored integrity fault and
  // stays fatal, like N2's schema and provenance checks. A dynamic tool that
  // repeats a host tool's name is dropped instead and the host tool is kept, so
  // a proxy definition can never displace a built-in.
  const staticPiNames = new Set<string>()
  for (const tool of staticTools) {
    if (staticPiNames.has(tool.binding.piName)) {
      throw new Error(`Pi execution manifest duplicate piName: ${tool.binding.piName}`)
    }
    staticPiNames.add(tool.binding.piName)
  }
  const tools = [...staticTools, ...dropLaterDuplicatePiNames(dynamic, staticPiNames, options.debug)]
    .sort((a, b) => a.binding.piName.localeCompare(b.binding.piName))
  for (const tool of tools) {
    if (!tool.binding.handlerName || tool.binding.handlerSchemaVersion !== 1) {
      throw new Error(`Pi execution manifest missing handler/schema version for ${tool.binding.piName}`)
    }
  }
  const unsigned = {
    surfaceVersion: seed.surfaceVersion,
    snapshotGeneration: seed.snapshotGeneration,
    sessionKey: seed.sessionKey,
    provenance: seed.provenance,
    mcpSources: seed.mcpSources,
    orchestrator: seed.orchestrator,
    deferredMcp: {
      enabled: deferredEnabled,
      candidatePiNames: deferredEnabled
        ? deferredCandidates.map(tool => tool.binding.piName).sort()
        : [],
    },
    tools,
  }
  return deepFreeze({ ...unsigned, manifestHash: hashCanonical(unsigned) })
}

/**
 * F1.706 — keep the FIRST tool of each piName and drop every later one with a
 * debug line: N2's degrade (one tool dropped, never the whole manifest and with
 * it every turn of the session) applied to a name listed twice, where the
 * manifest used to throw. `taken` holds the names already kept — empty for the
 * dynamic list against itself, the host's tools for the dynamic list against
 * them — and gains every name this call keeps.
 *
 * First-wins in the caller's order, as `partitionListedTools` keeps the first
 * tool of a name an MCP server lists (F1.695). Filtering keeps the order, so a
 * manifest with no repeated name is built exactly as before and hashes the same.
 */
function dropLaterDuplicatePiNames(
  tools: readonly ResolvedHarnessTool[],
  taken: Set<string>,
  debug: ((message: string) => void) | undefined,
): ResolvedHarnessTool[] {
  return tools.filter(tool => {
    const name = tool.binding.piName
    if (!taken.has(name)) {
      taken.add(name)
      return true
    }
    const from = tool.source.kind === 'resolvedCapability' ? tool.source.capabilityKey : `binding ${tool.source.bindingId}`
    debug?.(`pi-manifest: duplicate piName "${name}" — keeping the tool already in the manifest, dropping the later one from ${from}`)
    return false
  })
}

export function assertPiExecutionManifestIdentity(
  manifest: PiExecutionManifestV2,
  expected: { generation: string; manifestHash: string },
): void {
  if (manifest.surfaceVersion !== PI_EXECUTION_MANIFEST_VERSION) {
    throw new Error(`Unsupported Pi execution manifest version: ${manifest.surfaceVersion}`)
  }
  if (manifest.snapshotGeneration !== expected.generation) {
    throw new Error(`Pi execution manifest generation mismatch: expected ${expected.generation}, received ${manifest.snapshotGeneration}`)
  }
  if (manifest.manifestHash !== expected.manifestHash) {
    throw new Error('Pi execution manifest hash mismatch')
  }
  const { manifestHash: _hash, ...unsigned } = manifest
  if (hashCanonical(unsigned) !== manifest.manifestHash) {
    throw new Error('Pi execution manifest content hash mismatch')
  }
}

export function hashPiModelVisibleToolContract(input: {
  name: string
  description: string
  schema: unknown
  promptSnippet?: string
  promptGuidelines?: readonly string[]
  provenance: PiCapabilitySourceRef
}): string {
  return hashCanonical({
    name: input.name,
    description: input.description,
    schema: input.schema,
    promptSnippet: input.promptSnippet,
    promptGuidelines: input.promptGuidelines ?? [],
    provenance: input.provenance,
  })
}

export function sealPiExecutionManifest(manifest: PiExecutionManifestV2): PiExecutionManifestV2 {
  return deepFreeze(structuredClone(manifest))
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Pi execution manifest contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  throw new Error(`Pi execution manifest contains unsupported value: ${typeof value}`)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { PiChildResult, PiChildRestrictionsV1, PiChildSessionPort, PiChildStartInput } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import { clampThinkingLevelToModel, resolveEffortLevel, type ThinkingLevel } from '../../../shared/src/agent/thinking-levels.ts'
import { matchesSubagentToolDenial } from '../../../shared/src/agent/pi-harness/runtime-agent-definition.ts'
import { availableParallelism, cpus } from 'node:os'
import { backgroundTasksDisabled } from '../../../shared/src/config/background-task-settings.ts'
import { DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH } from '../../../shared/src/config/subagent-spawn-depth.ts'
import { getAgentSafetyCore } from '../../../shared/src/prompts/system.ts'
import { isForkAgentDefinition, type AgentDefinition, type AgentTier } from '../../../shared/src/agents/index.ts'
import { isModelInManagedAllowlist } from '../../../shared/src/config/managed-model-allowlist.ts'
import { isSubagentModelOverrideForced, resolveSubagentModelOverride } from '../../../shared/src/config/subagent-model.ts'
import { resolveSubagentPromptAppend } from '../../../shared/src/config/subagent-prompt-append.ts'
import {
  childSessionConcurrencyBackstop,
  concurrentSubagentLimitMessage,
  maxConcurrentSubagents,
} from '../../../shared/src/config/subagent-limits.ts'

export interface ChildSessionResult {
  agent: string
  agentId?: string
  worktreeLeaseId?: string
  status: 'done' | 'error' | 'aborted'
  text: string
  tokensIn: number
  tokensOut: number
  costUsd?: number
  error?: string
  /**
   * The child asked for one model and ran on another (Q6-D2). `sub-agents.md` § *Choose a
   * model*: "Claude Code shows a warning naming the requested model and the model the
   * subagent runs on" — so it travels beside the result into the parent's tool result
   * instead of a debug log. Absent whenever the child ran on the model asked for.
   */
  modelSubstitution?: { requested: string; resolved: string }
  /** F1.225 — the run stopped at its `maxTurns` cap: the text is partial and the child resumable. */
  turnLimitReached?: true
}

export interface SpawnChildSessionArgs {
  agentDef: AgentDefinition
  task: string
  model?: string
  effort?: ThinkingLevel
  cwd: string
  signal?: AbortSignal
  depth?: number
  ownerTaskId?: string
  backgroundTaskId?: string
  requestedAgentId?: string
  background?: boolean
  /**
   * `sub-agents.md:1048` — a CALL-SITE isolation request, valid only for a fork.
   * A named subagent declares `isolation` in its definition file (R30c), which
   * the host re-derives and validates; letting a caller override that would turn
   * a validated policy into a request. A fork has no definition, so this is its
   * only channel.
   */
  isolation?: 'worktree'
  hookAgentId?: string
  /**
   * `skills.md:569` — this spawn is driven by a `context: fork` SKILL BODY, and
   * the value is the skill's name. Forwarded ONLY; it grants nothing and narrows
   * nothing, and the host re-validates its shape. See
   * `PiChildRestrictionsV1.skillFork` for why the label has to travel with the
   * child rather than be re-derived from it.
   */
  skillFork?: { name: string }
  /**
   * WHICH ceiling this spawn answers to. `sub-agents.md:905` — agents that other
   * features run "follow their own limits instead" — so the subagent ceiling and
   * the workflow ceiling are two limits, not one, and the spawner cannot tell
   * them apart from the agent definition alone.
   *
   * - `agent-tool`  the model's own `subagent` call. Counted AND gated by
   *   {@link maxConcurrentSubagents}; never enters the workflow semaphore.
   * - `fork`        `/subtask` and `agent: "fork"`. Counted, never gated —
   *   `:902`, "takes a slot while it runs and is never blocked by the limit".
   * - `workflow`    a workflow stage's `agent()`. Keeps the `cpuCores - 2`
   *   semaphore, which is the workflow contract (`workflows.md:322`).
   * - `internal`    a host-run judge (review, guardian). Not the model's budget;
   *   keeps the semaphore.
   *
   * Defaults to `agent-tool` so an unmarked caller is GATED rather than
   * accidentally exempt.
   */
  limitScope?: 'agent-tool' | 'fork' | 'workflow' | 'internal'
  onAdmitted?: (agentId: string) => void
  onEvent?: (event: AgentSessionEvent) => void
}

export interface SpawnerRuntime {
  childSessionPort: PiChildSessionPort
  modelId: string
  tierModelMap?: Partial<Record<AgentTier, string>>
  /**
   * The managed model allowlist, delivered on the signed execution manifest.
   * Absent = no narrowing; `[]` blocks every named override. See
   * `PiOrchestratorConfig.availableModels`.
   */
  availableModels?: readonly string[]
  concurrency?: number
  maxDepth?: number
  maxFanout?: number
  tokenBudget?: number
  costBudgetUsd?: number
  timeoutMs?: number
  ancestry?: string[]
  /**
   * A READER for the session's own effort level, not the level itself.
   *
   * A function on purpose. `set_thinking_level` moves the session level at any
   * point in the conversation, while the spawner is only reconfigured when a
   * capability generation commits — so a level captured at `configureSpawner`
   * time is stale for every child spawned in between, and a session that raised
   * its effort mid-conversation kept delegating at the old one. Taking a reader
   * rather than a value makes that snapshot impossible to write again.
   */
  thinkingLevel?: () => ThinkingLevel | undefined
  /**
   * A READER for the rate-limit backoff base, for the same reason
   * `thinkingLevel` above is one.
   *
   * The value is endpoint-dependent — gateway children share one per-user
   * limiter with the parent, so 250ms re-hits a hot window before it can
   * reset — and `update_runtime_config` moves a session on and off the gateway
   * at any point, while the spawner is only reconfigured when a capability
   * generation commits. A value captured at `configureSpawner` time would keep
   * the old endpoint's backoff for every child spawned in between, which is
   * precisely the 250ms-into-a-throttled-gateway case this knob exists to stop.
   */
  retryBaseDelayMs?: () => number
  /**
   * Stable host-materialized prose context (workspace root, project summary)
   * inserted between the safety core and the agent system prompt of every
   * child session. Prose context only — it never widens child tool or
   * permission restrictions.
   */
  contextSeed?: string
  /**
   * This session's own model-visible tool pool. sub-agents.md:324 — "[Forks]
   * skip both filters and receive the main conversation's exact tool pool" —
   * so a fork's restriction list is this verbatim, not an agent definition's
   * `tools`. Absent for hosts that predate forks, which is why
   * `composeForkRestrictions` refuses to spawn a fork without it rather than
   * quietly handing the child an empty pool.
   */
  sessionToolNames?: readonly string[]
  /**
   * This session is itself a conversation fork. sub-agents.md:1052 — "A fork
   * can't spawn further forks." UNCONDITIONAL: a fork at depth 0 of a
   * `maxDepth: 3` tree still cannot fork, which is why this is a separate fact
   * from `maxDepth` rather than something derived from the budget.
   */
  isForkSession?: boolean
}

const DEFAULT_CONCURRENCY = 16
/**
 * Default child-session nesting depth: THREE subagent layers below the main
 * conversation (sub-agents.md:867, env-vars.md:281 "default: 3"). Must stay in
 * lockstep with `DEFAULT_PI_ORCHESTRATOR_CONFIG.depth`, which is where the host
 * gets its value, and with the plugin-hook budgets fallback in
 * `packages/server-core/src/sessions/SessionManager.ts` — otherwise whichever
 * one is higher silently wins as a fallback wherever the other is unset. The
 * env override (`NESSY_MAX_SUBAGENT_SPAWN_DEPTH` /
 * `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`) is resolved HOST-side into
 * `orchestrator.depth` at manifest seed time; this constant is only the static
 * fallback.
 */
export const DEFAULT_MAX_DEPTH = DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH
const MAX_ATTEMPTS = 3

/**
 * Rate-limit backoff base when the caller supplies no reader. Sized for a
 * per-request provider limiter, NOT for the Nestor gateway's per-user one —
 * `configureSpawnerForGeneration` raises it there.
 */
export const DEFAULT_SPAWN_RETRY_BASE_DELAY_MS = 250

/**
 * The host's refusal when this session has spent past its `--max-budget-usd`
 * ceiling — `CHILD_SESSION_BUDGET_EXHAUSTED_ERROR` in
 * `packages/server-core/src/pi-harness/child-session-service.ts`, arriving here
 * verbatim through `pi-agent.ts`'s `child_session_response`.
 *
 * RE-DECLARED, not imported: server-core is host code and importing it would
 * pull the host into the Pi subprocess bundle. `spawner-budget-cap.test.ts`
 * imports both and pins them equal, so the copy cannot drift silently.
 */
export const HOST_BUDGET_EXHAUSTED_ERROR = 'child-session-max-budget-usd-exhausted'

/**
 * What the MODEL is told when the cap refuses it a child — on EITHER door.
 *
 * The host's error code is a host-internal string; handed to the model
 * unchanged it reads as a crash, and the documented shape for a ceiling that
 * refuses rather than queues (`sub-agents.md:898`) is a sentence naming the
 * limit and telling the model not to retry. The alternative — a silent no-op or
 * an empty "done" — is the failure this task exists to close.
 *
 * Both doors say it: the spawn path here, and the `resume` path in
 * `subagent-tool.ts`, which the host gates for the same reason (`:903` — a
 * resume "takes a fresh slot"). A refusal that speaks on one door and leaks the
 * raw code on the other is a worse contract than either alone.
 *
 * "ask the user to raise the limit" is advice that WORKS: the ceiling is
 * re-read per turn on the producer's side and the host's latch is cleared per
 * turn to match, so a cap raised now stops binding on the next turn.
 */
export const BUDGET_EXHAUSTED_SPAWN_MESSAGE =
  'Subagent refused: this session has reached its spending limit, so no new subagents can be started. '
  + 'Do not retry — finish with what you already have, or ask the user to raise the limit.'

/**
 * The operator's background OFF SWITCH, as the host spells its refusal — P6.237.
 *
 * RE-DECLARED for the same reason {@link HOST_BUDGET_EXHAUSTED_ERROR} is:
 * server-core is host code and importing it would pull the host into the Pi
 * subprocess bundle. `spawner-agent-view-disabled.test.ts` imports both and
 * pins them equal, so the copy cannot drift silently.
 */
export const HOST_AGENT_VIEW_DISABLED_ERROR = 'child-session-disabled-by-managed-policy'

/**
 * What the MODEL is told when the administrator has turned background agents off.
 *
 * A separate sentence from the budget one, deliberately: both refusals arrive on
 * the same door with the same shape, and a model told "you have reached your
 * spending limit" when the real answer is "your administrator disabled this"
 * will tell the user to raise a limit that is not the obstacle. Neither refusal
 * is retryable, and only one of them can be cleared by the user.
 */
export const AGENT_VIEW_DISABLED_SPAWN_MESSAGE =
  'Subagent refused: background agents are turned off for this installation by managed policy '
  + '(disableAgentView). Do not retry — do the work in this session, or ask your administrator.'

/** Did this error carry the host's managed-policy refusal? Same shape as {@link isBudgetExhaustedError}. */
export function isAgentViewDisabledError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(HOST_AGENT_VIEW_DISABLED_ERROR)
}

/**
 * Number of logical CPUs available to this process. `availableParallelism`
 * respects cgroup/affinity limits (container-aware); `cpus().length` is the
 * fallback for older runtimes where it is missing.
 */
function detectCpuCores(): number {
  try {
    const n = availableParallelism()
    if (Number.isFinite(n) && n >= 1) return n
  } catch {
    // availableParallelism unavailable — fall through to cpus()
  }
  const count = cpus().length
  return count >= 1 ? count : 1
}

/**
 * Effective parallel-children semaphore size (T1) — the WORKFLOW ceiling, and
 * since R60 only that. `workflows.md:322`: "Up to 16 concurrent agents, fewer on
 * machines with limited CPU cores." The orchestrator config carries a
 * machine-independent `concurrency` ceiling (default 16); the actual runtime cap
 * is narrowed to `cpuCores - 2` so a many-agent fan-out cannot starve the host,
 * and floored at 1 so a small-core machine still makes progress. `cpuCores` is
 * injectable for deterministic tests.
 *
 * The Agent-tool path deliberately does NOT pass through this semaphore: it is
 * governed by {@link maxConcurrentSubagents} (`sub-agents.md:898`), which refuses
 * rather than queues, and a `cpuCores - 2` queue in front of it would make the
 * documented 20 unreachable on any machine with 21 or fewer cores. That
 * conflation — one semaphore serving both limits — is finding f086.
 */
export function computeEffectiveConcurrency(
  requested: number | undefined,
  cpuCores: number = detectCpuCores(),
): number {
  const ceiling = requested && requested > 0 ? requested : DEFAULT_CONCURRENCY
  return Math.max(1, Math.min(ceiling, cpuCores - 2))
}

export class Semaphore {
  private active = 0
  private queue: Array<{
    resolve: () => void
    reject: (error: Error) => void
    signal?: AbortSignal
    onAbort?: () => void
  }> = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      throwIfAborted(signal)
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortedError())
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.queue)[number] = { resolve, reject, ...(signal ? { signal } : {}) }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter)
          if (index < 0) return
          this.queue.splice(index, 1)
          signal.removeEventListener('abort', waiter.onAbort!)
          reject(abortedError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.queue.push(waiter)
      if (signal?.aborted) waiter.onAbort?.()
    })
  }

  private release(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!
      if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
      if (next.signal?.aborted) {
        next.reject(abortedError())
        continue
      }
      next.resolve()
      return
    }
    this.active -= 1
  }
}

let runtime: SpawnerRuntime | null = null
let semaphore = new Semaphore(computeEffectiveConcurrency(DEFAULT_CONCURRENCY))

/**
 * How many subagents are RUNNING in this session — the count
 * `sub-agents.md:898`'s limit is measured against.
 *
 * A plain counter, not a semaphore, because the documented behaviour is a
 * REFUSAL and a semaphore is a queue: "spawning another with the Agent tool
 * fails … and the error tells Claude not to retry". A queued spawn eventually
 * succeeds, so the model never learns it over-fanned-out — which is the half of
 * f086 that is invisible today.
 *
 * Counts `agent-tool` and `fork` spawns (`:902` — a fork "takes a slot while it
 * runs") and resumes (`:903` — a resume "takes a fresh slot without checking the
 * limit, so resumes can push the running count past it"). Only `agent-tool` is
 * ever refused.
 */
let runningSubagents = 0

export function configureSpawner(nextRuntime: SpawnerRuntime): void {
  runtime = nextRuntime
  semaphore = new Semaphore(computeEffectiveConcurrency(nextRuntime.concurrency))
  // A capability generation commits by rebuilding the spawner, and the old
  // generation's children are torn down with it — so the count restarts with the
  // semaphore rather than leaking a slot per generation.
  runningSubagents = 0
}

/**
 * Did this error carry the host's budget refusal?
 *
 * There is deliberately NO subprocess-side latch behind this. The host
 * re-evaluates the ceiling every turn (`SessionManager` clears
 * `maxBudgetUsdReached` at turn start, mirroring `getMaxBudgetUsd`'s per-turn
 * config read), and this process has no turn boundary to invalidate a cached
 * copy against — `configureSpawner` fires per capability generation, which can
 * be many turns apart. A cached refusal would therefore outlive a raised cap
 * and keep refusing children the host is willing to admit, which is the exact
 * failure the per-turn clear exists to remove. Asking costs nothing extra: the
 * refusal arrives on the `start` call every spawn already makes.
 */
export function isBudgetExhaustedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(HOST_BUDGET_EXHAUSTED_ERROR)
}

/**
 * Hold a subagent slot for the life of `run`, WITHOUT checking the limit.
 *
 * `sub-agents.md:903` — "[r]esuming a subagent that already finished takes a
 * fresh slot without checking the limit, so resumes can push the running count
 * past it." Exported because the resume path does not go through the spawner at
 * all (it calls `childSessionPort.resume` directly), and a resumed child that
 * did not occupy a slot would make the count a lie in exactly the direction the
 * sentence warns about.
 */
export async function withResumedSubagentSlot<T>(run: () => Promise<T>): Promise<T> {
  runningSubagents += 1
  try {
    return await run()
  } finally {
    runningSubagents -= 1
  }
}

function getRuntime(): SpawnerRuntime {
  if (!runtime) throw new Error('Orchestrator spawner is not configured')
  return runtime
}

/**
 * The child's model, and the substitution to declare if the requested one was
 * not this session's to give.
 *
 * `resolved` is always a model this session can actually run;
 * `substitution` is present only when a DELEGATED input (frontmatter `model`,
 * the Agent tool's `model` parameter, `NESSY_SUBAGENT_MODEL`) named something
 * else and was replaced.
 */
interface ResolvedAgentModel {
  resolved: string
  substitution?: { requested: string; resolved: string }
}

function resolveAgentModelId(agentDef: AgentDefinition, cfg: SpawnerRuntime, callModel?: string): ResolvedAgentModel {
  const available = new Set([cfg.modelId, ...Object.values(cfg.tierModelMap ?? {})].filter(Boolean))
  const inherited = (): string => cfg.tierModelMap?.[agentDef.tier] ?? cfg.modelId
  /**
   * Q6-D2. A model this session cannot serve used to THROW here, and the whole
   * spawn failed — measured live on the gateway, where `claude-security`'s
   * `model: sonnet` agents were unspawnable (`Agent model unavailable: sonnet`).
   *
   * `sub-agents.md` § *Choose a model*: "For any other blocked value, on
   * providers where that substitution doesn't operate, or when the allowlist
   * permits no version of the family, Claude Code runs the subagent on the
   * inherited model instead." A gateway that serves neither `sonnet` nor any
   * version of that family is exactly the case that sentence's middle clause
   * covers, and the refusal contradicted the fallback the comment below already
   * quoted.
   *
   * It is a substitution, never a widening: the replacement is the inherited or
   * tier model, both of which the host already resolved through the managed
   * allowlist, and `permitted` still screens the requested value first — so an
   * admin-blocked model cannot arrive here and be honoured.
   *
   * Not silent, per the same section: "In interactive sessions, Claude Code
   * shows a warning naming the requested model and the model the subagent runs
   * on, for either substitution." The pair is carried out on the result and
   * rendered in the parent's own tool result.
   */
  const orInherited = (requested: string): ResolvedAgentModel => {
    if (!agentDef.capabilityGeneration || available.has(requested)) return { resolved: requested }
    const resolved = inherited()
    return { resolved, substitution: { requested, resolved } }
  }
  // `settings-reference.md#availablemodels`'s allowlist — it covers "the main
  // session, subagents, skills, and the advisor" — applied to the two delegated
  // inputs
  // `model-config.md:154` names: subagent frontmatter `model` and the Agent
  // tool's `model` parameter.
  //
  // A refused override is DROPPED, not raised. `model-config.md`
  // § *Restrict model selection*, the row for a blocked selection: "**Subagent
  // or teammate override**: Claude Code falls back to the subagent's inherited
  // model or the default teammate model rather than failing the request." (The
  // page has since split the skill/command case into its own row; quoted
  // without a line number because the line moved and the sentence did not.) So
  // the resolution below continues into `tierModelMap[tier] ?? cfg.modelId`,
  // both of which the host already resolved through the same allowlist.
  //
  // The inherited fallback is what makes dropping safe: there is no path where
  // clearing the override leaves the child with no model.
  const permitted = (value: string | undefined): string | undefined =>
    value !== undefined && isModelInManagedAllowlist(cfg.availableModels, value)
      ? value
      : undefined
  const perCallModel = permitted(callModel?.trim())
  const explicitModel = permitted(agentDef.model?.trim())
  // P6.364 — the DOCUMENTED order, replacing the superseded one this block used
  // to implement. `sub-agents.md#choose-a-model`, quoted whole and re-read
  // 2026-09-06 (HTTP 200):
  //
  //   1. The per-invocation `model` parameter
  //   2. The subagent definition's `model` frontmatter, where `inherit` selects
  //      the main conversation's model
  //   3. The `CLAUDE_CODE_SUBAGENT_MODEL` environment variable, when you set it
  //      to a model alias or model ID
  //   4. The main conversation's model
  //
  // and, in the same section: "Before v2.1.251, `CLAUDE_CODE_SUBAGENT_MODEL`
  // came first in this order and overrode both the per-invocation parameter and
  // the frontmatter, including `model: inherit`." The comment that stood here
  // quoted `model-config.md:611` for the OPPOSITE rule; that row is gone from
  // the page and `subagent-model.ts`'s docblock records the correction.
  //
  // The override still passes through `permitted` and `available`, so the
  // managed allowlist and a child-session model ceiling keep binding at
  // whichever tier it wins from — an operator variable outranks the delegated
  // inputs only where the page says it does, never the organization's policy.
  // `inherit` never reaches here as a VALUE: `resolveSubagentModelOverride`
  // maps it to `undefined`, which is "use normal model resolution instead".
  const envModel = permitted(resolveSubagentModelOverride())
  // `#run-every-subagent-on-one-model`: "To apply one model to every subagent,
  // teammate, and workflow agent, also set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
  // to `1`" — the pre-v2.1.251 order, restored on request. FORCE with no model
  // named decides NOTHING here, per the same section's "If you set only
  // `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, subagents run on the main
  // conversation's model": `envModel` is `undefined` and every tier below runs
  // unchanged.
  //
  // The fork carve-out is the page's, verbatim: under FORCE "Two kinds of
  // subagent still run on the main conversation's model: A fork; A skill that
  // runs in a subagent with `model: inherit`". Only the FIRST is expressible
  // here — `AgentDefinition` carries `fork?: true` but no marker saying a
  // definition was forked from a skill, so the second exception is UNHONOURED
  // and said so rather than silently approximated.
  if (envModel !== undefined && isSubagentModelOverrideForced() && !isForkAgentDefinition(agentDef)) {
    return orInherited(envModel)
  }
  if (agentDef.capabilityGeneration
    && explicitModel && explicitModel !== 'inherit'
    && perCallModel && perCallModel !== 'inherit'
    && perCallModel !== explicitModel) {
    throw new Error(`Agent model ceiling mismatch: ${perCallModel}`)
  }
  // Tiers 1 and 2. `inherit` at either tier is a DECISION, not a fall-through:
  // the page defines it as "selects the main conversation's model", so it must
  // land on `inherited()` below rather than continue into the environment
  // variable at tier 3. Before this row the distinction could not be observed,
  // because tier 3 was resolved above both.
  if (perCallModel === 'inherit' || explicitModel === 'inherit') return { resolved: inherited() }
  if (perCallModel) return orInherited(perCallModel)
  if (explicitModel) return orInherited(explicitModel)
  // Tier 3, then tier 4.
  if (envModel) return orInherited(envModel)
  return { resolved: inherited() }
}

/** The session's level as of NOW — see {@link SpawnerRuntime.thinkingLevel}. */
function sessionThinkingLevel(cfg: SpawnerRuntime): ThinkingLevel | undefined {
  return cfg.thinkingLevel?.()
}

/**
 * The child's effort level. `sub-agents.md:289` — subagent frontmatter `effort`
 * "Overrides the session effort level. Default: inherits from session" — so the
 * whole precedence lives in `resolveEffortLevel`, the same resolver the skill
 * path calls.
 *
 * The per-model narrowing of `model-config.md:452` is applied AFTER, as a
 * separate step against the child's own resolved model: raising to what the
 * frontmatter asked and lowering to what the model can run are two rules, and
 * the second one must never be able to masquerade as the first.
 */
function effectiveThinkingLevel(
  agentDef: AgentDefinition,
  requested: ThinkingLevel | undefined,
  inherited: ThinkingLevel | undefined,
  modelId: string,
): ThinkingLevel {
  const resolved = resolveEffortLevel({ session: inherited, declared: agentDef.effort, invocation: requested })
  return clampThinkingLevelToModel(resolved, modelId)
}

/**
 * The child's pool, minus what `disallowedTools` removes.
 *
 * {@link matchesSubagentToolDenial} is the ONE rule, shared with the host's own
 * re-validation of the list this produces (`SessionManager.ts`,
 * `runtime-agent-tool-unavailable:<tool>`). Filtering here with a rule the host
 * does not read — or vice versa — is how a bare `mcp__<server>` denial came to
 * remove nothing on either side.
 */
function allowedTools(agentDef: AgentDefinition): string[] {
  return agentDef.tools.filter(tool => matchesSubagentToolDenial(tool, agentDef.disallowedTools, 'subagent disallowedTools') === null)
}

/**
 * Child prompt = safety core + optional stable context seed + agent prompt +
 * the operator's append.
 *
 * The seed is prose context only; restrictions/budgets are composed elsewhere
 * and are never derived from it.
 *
 * ## P6.314 (H34) — the operator's append, and why it is LAST
 *
 * `NESSY_APPEND_SUBAGENT_SYSTEM_PROMPT` is the host's answer to claude's own
 * `--append-subagent-system-prompt`, and "append" is the whole contract: the
 * operator's sentence is the most recent instruction the child reads, after the
 * agent's own prompt rather than buried under it. It never displaces the safety
 * core, which stays first.
 *
 * **Nested children are included by construction, not by a second rule.** Every
 * named subagent this process spawns — at any depth — reaches the model through
 * this one function, so a knob read here binds the whole tree. That is the
 * clause `done_means` calls "nested children included", and it is a property of
 * the composer rather than a traversal.
 *
 * **The fork carve-out is honoured by construction too, and this is the part
 * worth reading twice.** `sub-agents.md` requires a fork's system prompt to be
 * "Same as main session"; {@link composeForkRestrictions} therefore returns
 * `prompt: ''` and never calls this function, so a fork inherits the parent's
 * conversation prompt and cannot receive the append a second time. It also
 * means a fork does not receive it a FIRST time — stated rather than hidden,
 * because that is the same answer the page's own carve-out gives: a fork is the
 * conversation continuing, not a subagent being briefed.
 *
 * Read per composition rather than cached at `configureSpawner`, matching the
 * subagent-model override two functions down: an operator's `env` block can
 * change under a long-lived process, and a prompt fragment resolved once at
 * startup is the stale-knob shape this plan keeps finding.
 */
export function composeChildPrompt(cfg: SpawnerRuntime, agentDef: AgentDefinition): string {
  const contextSeed = cfg.contextSeed?.trim()
  const operatorAppend = resolveSubagentPromptAppend()
  return [
    getAgentSafetyCore().trim(),
    ...(contextSeed ? [contextSeed] : []),
    agentDef.systemPrompt.trim(),
    ...(operatorAppend ? [operatorAppend] : []),
  ].join('\n\n')
}

/**
 * A fork's child restrictions (sub-agents.md § *How forks differ from named
 * subagents*, :1038–:1044). Every value comes from THIS session, never from an
 * agent definition — `FORK_AGENT_DEFINITION` throws if `systemPrompt`, `tools`
 * or `model` is read, so this function is the only thing standing between the
 * caller and a loud failure.
 *
 * - `prompt: ''` is deliberate, not a placeholder. The child backend composes
 *   `baseSystemPrompt + childSystemPrompt`; an empty child prompt leaves the
 *   fork with exactly the session prompt the parent composes for itself, which
 *   is what ":1041 System prompt and tools | Same as main session" and :1046's
 *   shared prompt cache both require. Prepending `getAgentSafetyCore()` the way
 *   `composeChildPrompt` does for a named subagent would make the two prefixes
 *   differ and break both.
 * - `permissionMode` is OMITTED, which the host reads as "inherit the parent's
 *   mode verbatim". A fork must never carry a mode of its own: an omitted mode
 *   is the one input `clampPermissionModeToParent` cannot widen.
 */
function composeForkRestrictions(cfg: SpawnerRuntime, isolation?: 'worktree'): PiChildRestrictionsV1 {
  const tools = cfg.sessionToolNames
  if (!tools) throw new Error('fork-session-tool-pool-unavailable: this host cannot resolve the parent tool pool a fork must inherit')
  return {
    prompt: '',
    model: cfg.modelId,
    tools: [...tools],
    // A fork declares nothing of its own, so this is the session level verbatim
    // — and, when the host declared none, the session default rather than `off`.
    // Read now, not at `configureSpawner`, and narrowed to what this session's
    // model can actually run.
    thinkingLevel: clampThinkingLevelToModel(resolveEffortLevel({ session: sessionThinkingLevel(cfg) }), cfg.modelId),
    // sub-agents.md:1048 — "When Claude spawns a fork through the Agent tool, it
    // can pass `isolation: "worktree"` so the fork's file edits are written to a
    // separate git worktree instead of your checkout." A fork has no definition,
    // so unlike a named subagent this can only ever arrive from the call site.
    // Default stays `shared`: a fork inherits the parent's working tree along
    // with everything else unless the caller asks otherwise.
    worktreePolicy: isolation === 'worktree' ? 'isolated-worktree' : 'shared',
    fork: true,
  }
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return String(error).includes('429')
  const record = error as Record<string, unknown>
  return record.status === 429
    || record.statusCode === 429
    || record.code === 429
    || String(record.message ?? '').includes('429')
    || String(record.message ?? '').toLowerCase().includes('rate limit')
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError())
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortedError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function abortedError(): Error {
  return new Error('aborted')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError()
}

async function startWithAbort(
  childSessionPort: PiChildSessionPort,
  input: PiChildStartInput,
  signal?: AbortSignal,
): Promise<PiChildResult | null> {
  if (!signal) return childSessionPort.start(input)
  if (signal.aborted) return null

  let startInvoked = false
  let abortHandled = false
  let resolveAbort!: (value: null) => void
  const aborted = new Promise<null>(resolve => { resolveAbort = resolve })
  const onAbort = () => {
    if (abortHandled) return
    abortHandled = true
    if (!startInvoked) {
      resolveAbort(null)
      return
    }
    void childSessionPort.stop(input.requestedAgentId!).catch(() => {}).finally(() => resolveAbort(null))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  if (signal.aborted) {
    signal.removeEventListener('abort', onAbort)
    return null
  }

  let start!: Promise<PiChildResult>
  try {
    startInvoked = true
    start = childSessionPort.start(input)
    const result = await Promise.race([start, aborted])
    if (result === null) {
      // A stop can race ahead of host-side durable admission. Re-stop the
      // actual admitted id once a late start settles so it cannot orphan.
      void start.then(late => childSessionPort.stop(late.agentId).catch(() => {})).catch(() => {})
      return null
    }
    if (signal.aborted) {
      await childSessionPort.stop(result.agentId).catch(() => {})
      return null
    }
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function monitorWithAbort(
  childSessionPort: PiChildSessionPort,
  agentId: string,
  signal?: AbortSignal,
): Promise<PiChildResult | null> {
  if (!signal) return childSessionPort.monitor(agentId)
  if (signal.aborted) {
    await childSessionPort.stop(agentId).catch(() => {})
    return null
  }

  let abortHandled = false
  let resolveAbort!: (value: null) => void
  const aborted = new Promise<null>(resolve => { resolveAbort = resolve })
  const onAbort = () => {
    if (abortHandled) return
    abortHandled = true
    void childSessionPort.stop(agentId).catch(() => {}).finally(() => resolveAbort(null))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()

  let monitor!: Promise<PiChildResult>
  try {
    monitor = childSessionPort.monitor(agentId)
    const result = await Promise.race([monitor, aborted])
    if (result === null) {
      void monitor.catch(() => {})
      return null
    }
    if (signal.aborted) {
      await childSessionPort.stop(agentId).catch(() => {})
      return null
    }
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Best-effort partial text for a child whose start REJECTED. The host writes a
 * child's output onto its durable record before a failure propagates, so the
 * record can still hold real work even though the call threw. Never throws and
 * never waits: an unknown agent id simply yields nothing, so the failure shape
 * degrades to exactly what it was before.
 */
async function recoverPartialText(port: PiChildSessionPort, agentId: string): Promise<string> {
  try {
    const record = await port.getResult(agentId, { wait: false })
    return record.result ?? record.output ?? ''
  } catch {
    return ''
  }
}

export async function spawnChildSession(args: SpawnChildSessionArgs): Promise<ChildSessionResult> {
  const cfg = getRuntime()
  const isFork = isForkAgentDefinition(args.agentDef)
  // :1052, checked BEFORE the depth budget on purpose: the rule is
  // unconditional, so a fork with plenty of depth headroom must still be
  // refused, and the message has to say why rather than blaming the depth limit.
  if (isFork && cfg.isForkSession === true) {
    return failure(args.agentDef.name, 'a fork cannot spawn another fork: this session is already a conversation fork. Delegate to a named subagent instead, or ask the main session to fork.')
  }
  // :1048 scopes the call-site `isolation` argument to a fork. A named
  // subagent's isolation comes from its definition file and is re-derived and
  // validated host-side; honouring a call-site override for it would silently
  // widen a validated policy, and ignoring it would be the "parsed on one path,
  // read on none" defect. Refusing says which.
  if (args.isolation && !isFork) {
    return failure(args.agentDef.name, `isolation is only available on a fork: declare "isolation: worktree" in the ${args.agentDef.name} agent definition instead.`)
  }
  // The mirror of the host's own refusal. `skills.md:569` — a forked skill "won't
  // have access to your conversation history" — while `fork: true` means it
  // inherits all of it, so the pair is a contradiction rather than a stronger
  // request, and it is refused here as well as host-side so the reason is stated
  // at the call site that wrote it.
  if (args.skillFork && isFork) {
    return failure(args.agentDef.name, 'a forked skill runs as a named subagent and cannot also be a conversation fork: name a subagent type in the skill\'s "agent" frontmatter.')
  }
  // P6.17 — THE ZERO-TOOL REFUSAL, and it is a refusal rather than a diagnostic
  // because the alternative is a worker that burns a model turn to accomplish
  // nothing and says nothing about why.
  //
  // `errors.md#agent-would-be-spawned-with-zero-tools`: "Every entry in the
  // subagent's `tools` list failed to match a usable tool, so Claude Code refused
  // to launch the subagent: with no tools, it couldn't act." Refused HERE because
  // this is the layer that can refuse: the builder that did the resolving
  // (`runtime-agent-definitions.ts`) said so in its own docblock, and the page
  // prices the refusal at one launch — "pass a different subagent_type" — never
  // at the conversation.
  //
  // The condition itself is `zeroToolResolution`'s to state, not this function's:
  // by the time a definition arrives here the always-available task tools have
  // been unioned in, so an all-failed list and an authored-empty one are
  // byte-identical pools. A fork is exempt by construction — it declares no tools
  // and inherits the session's — and every definition whose tools were never
  // resolved against a manifest carries no verdict at all.
  const zeroTools = isFork ? undefined : args.agentDef.zeroToolResolution
  if (zeroTools) {
    return failure(args.agentDef.name, zeroToolRefusalMessage(args.agentDef.name, zeroTools))
  }
  const depth = (args.depth ?? 0) + 1
  // sub-agents.md:326 and :862 — at the depth limit the `Agent` tool is
  // WITHHELD from a named subagent but "stays listed" in a fork and "returns an
  // error instead of spawning". This return is that error: the fork keeps
  // `subagent` in its inherited pool and the call fails here at call time.
  if (depth > (cfg.maxDepth ?? DEFAULT_MAX_DEPTH)) {
    return failure(args.agentDef.name, `Subagent depth limit exceeded (${cfg.maxDepth ?? DEFAULT_MAX_DEPTH})`)
  }
  if (args.signal?.aborted) return failure(args.agentDef.name, 'aborted', 'aborted')
  // THE CONCURRENT-SUBAGENT CEILING (sub-agents.md:898), and the one gate on this
  // path that may ever refuse.
  //
  // Three gates sit on one Agent-tool spawn and each has a different voice:
  //   (a) this counter, which fails the spawn with the DOCUMENTED message;
  //   (b) the host's per-parent backstop in `child-session-service.ts`, TWO counts:
  //       `concurrency` over its `active` set (forks and resumed children included,
  //       `child-session-concurrency-limit`) and `fanout` over every child EVER (below);
  //   (c) the host's memory bound, which throws `live-agent-ceiling-reached` —
  //       and for a BACKGROUND child throws it asynchronously, so the model sees
  //       a failed subagent rather than a refused spawn.
  // (a) is made to bind first by construction: `maxConcurrentSubagents()` is
  // narrowed against the same memory formula (c) uses and stays strictly below
  // it, and the budget sent for (b) is the sum of both scoped ceilings plus
  // headroom. See `shared/src/config/subagent-limits.ts` for the arithmetic.
  //
  // Counted-but-not-gated is the fork rule (`holdsSubagentSlot`, read against
  // the `agent-tool`-only gate on the next line); resumes are counted by
  // `withResumedSubagentSlot` at its only call site, `subagent-tool.ts:683` —
  // not in this file. An `ultracode`
  // session is exempt from the CHECK but not from the COUNT —
  // `sub-agents.md#concurrent-subagent-limit`, "Sessions with ultracode active
  // are exempt: the limit isn't enforced there" — and it is the one shape in
  // which (b) or (c) can still speak, because an exempt session's Agent-tool
  // fan-out is unbounded HERE and can therefore run into the per-parent backstop
  // or the memory bound, whose refusals are host-internal strings rather than
  // the documented message. That residue is deliberate: removing either would
  // trade a wrongly-worded refusal for an unbounded one.
  //
  // WHAT `ultracode` MEANS HERE, spelled out because a sweep has already read it
  // the other way (P2.341, which reported this exemption as unimplemented): it
  // is the MAX EFFORT LEVEL. That same doc sentence links the word to
  // `model-config#adjust-effort-level`, and `shared/src/automations/types.ts`
  // records that this fork has no `ultracode` effort level of its own — `max` is
  // it. The identically-spelled `WORKFLOW_TRIGGER_KEYWORD` in
  // `shared/src/workflows/workflow-keyword.ts` is a DIFFERENT thing: a
  // per-prompt, human-origin, Pi-only opt-in to workflow orchestration. Keying
  // this gate on that keyword would exempt a default-effort session that merely
  // typed a word, and would keep gating a max-effort session that did not.
  const limitScope = args.limitScope ?? 'agent-tool'
  const holdsSubagentSlot = limitScope === 'agent-tool' || limitScope === 'fork'
  if (limitScope === 'agent-tool' && sessionThinkingLevel(cfg) !== 'max') {
    const subagentCeiling = maxConcurrentSubagents()
    if (runningSubagents >= subagentCeiling) {
      return failure(args.agentDef.name, concurrentSubagentLimitMessage(subagentCeiling))
    }
  }
  // Background default: top-level spawns (depth 1) run as durable background
  // children; nested spawns stay foreground. An explicit call-site
  // `background` argument otherwise wins. The spawner still awaits `monitor`
  // for background children, so callers always receive completed results.
  //
  // sub-agents.md `background` row: "Set to `true` to always run this subagent
  // as a background task, EVEN WHEN Claude needs its result right away." The
  // definition therefore outranks the call site, which is the one place a
  // caller asking for a foreground result would otherwise override it. `false`
  // is not the mirror image: the row only defines the `true` case, and "when
  // unset, Claude chooses", so a definition that omits the field leaves the
  // existing depth default in charge.
  //
  // `NESSY_DISABLE_BACKGROUND_TASKS` outranks even the frontmatter `true`
  // (sub-agents.md:783 gives it precedence over fork mode, and env-vars.md makes
  // it the hard off switch for "all background task functionality"); without
  // this arm a definition-level `background: true` would keep detaching under
  // the off switch.
  const background = backgroundTasksDisabled()
    ? false
    : isFork
      ? args.background ?? true
      : args.agentDef.background === true
        ? true
        : args.background ?? (depth === 1)

  let restrictions: PiChildRestrictionsV1
  let modelSubstitution: ChildSessionResult['modelSubstitution']
  try {
    const childModel = isFork ? { resolved: cfg.modelId } : resolveAgentModelId(args.agentDef, cfg, args.model)
    const childModelId = childModel.resolved
    modelSubstitution = childModel.substitution
    restrictions = isFork
      ? composeForkRestrictions(cfg, args.isolation)
      : {
        prompt: composeChildPrompt(cfg, args.agentDef),
        model: childModelId,
        tools: allowedTools(args.agentDef),
        // The session level is read HERE, at spawn time. A level captured when
        // the spawner was configured is stale after `set_thinking_level`.
        thinkingLevel: effectiveThinkingLevel(args.agentDef, args.effort, sessionThinkingLevel(cfg), childModelId),
        // `isolation: worktree` is an explicit author request for "an
        // isolated copy of the repository", so it wins over the
        // toolset-derived default. It only ever narrows — a read-only
        // agent moves OUT of the shared live tree, never into it — which
        // is why it is safe to let it override the rule the
        // ORCHESTRATION_TOOLS note guards.
        //
        // P8: the host recomputes this verdict, and it now does so through
        // ONE shared rule (`piRuntimeAgentWorktreePolicy`) that this
        // expression must stay equal to. `toolset` is the shared rule's
        // read-only half, applied to the author-DECLARED list
        // (`runtime-agent-definitions.ts`); this line is its `isolation`
        // half, kept here because the spawner also serves BUILTIN
        // definitions, whose `toolset` is authored rather than derived. The
        // equality is pinned by the cross-side table in
        // `runtime-agent-definitions.test.ts` — change either and that
        // table fails.
        worktreePolicy: args.agentDef.isolation === 'worktree' || args.agentDef.toolset === 'full'
          ? 'isolated-worktree'
          : 'shared',
        // Additive per-agent policy; omitted when unset so legacy child
        // requests stay byte-identical. The host enforces maxTurns and clamps
        // permissionMode against the parent — the spawner only forwards the
        // agent-def's request.
        ...(args.agentDef.maxTurns === undefined ? {} : { maxTurns: args.agentDef.maxTurns }),
        ...(args.agentDef.permissionMode === undefined ? {} : { permissionMode: args.agentDef.permissionMode }),
        ...(args.agentDef.capabilityGeneration ? { capabilityGeneration: args.agentDef.capabilityGeneration } : {}),
        ...(args.agentDef.definitionKey ? { definitionKey: args.agentDef.definitionKey } : {}),
        ...(args.agentDef.definitionDigest ? { definitionDigest: args.agentDef.definitionDigest } : {}),
        ...(args.agentDef.skillKeys ? { skillKeys: [...args.agentDef.skillKeys] } : {}),
        ...(args.agentDef.mcpServerKeys ? { mcpServerKeys: [...args.agentDef.mcpServerKeys] } : {}),
        // sub-agents.md:517-527, the `memory:` scope. FORWARDED ONLY — the
        // spawner neither composes the memory block nor widens `tools` for it,
        // and both omissions are load-bearing:
        //
        // - The prompt block cannot go in `composeChildPrompt`. The host asserts
        //   the child prompt ENDS WITH the pinned system prompt
        //   (`runtime-agent-definition-prompt-mismatch`), so a fourth segment
        //   here fails admission. The host appends it after that check, where
        //   the project root and the auto-memory setting are also authoritative.
        // - `:527`'s Read/Write/Edit grant cannot go in `allowedTools` either.
        //   The host re-validates this list against the AUTHOR-declared `tools`,
        //   so a `toolset: read-only` agent arriving with `write` is refused
        //   with `runtime-agent-tool-unavailable:write` — the fix would fail
        //   closed on exactly the agents the page's own `code-reviewer` example
        //   describes. The host applies the grant after that check.
        //
        // `toolset` is deliberately not recomputed from any of this:
        // `worktreePolicy` above reads it, so a read-only memory agent whose
        // toolset flipped to 'full' would silently move out of the shared tree
        // into an isolated worktree — and its project-scope memory with it.
        ...(args.agentDef.memory ? { memory: args.agentDef.memory } : {}),
        // Appended LAST, matching `PiChildRestrictionsV1`'s own ordering rule.
        ...(args.skillFork ? { skillFork: { name: args.skillFork.name } } : {}),
      }
  } catch (error) {
    return failure(args.agentDef.name, error instanceof Error ? error.message : String(error))
  }

  const runSpawn = async (): Promise<ChildSessionResult> => {
    throwIfAborted(args.signal)
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      throwIfAborted(args.signal)
      const requestedAgentId = attempt === 1 && args.requestedAgentId ? args.requestedAgentId : crypto.randomUUID()
      try {
        const result = await startWithAbort(cfg.childSessionPort, {
          agent: args.agentDef.name,
          task: args.task,
          ...(args.ownerTaskId ? { ownerTaskId: args.ownerTaskId } : {}),
          ...(args.backgroundTaskId ? { backgroundTaskId: args.backgroundTaskId } : {}),
          background,
          restrictions,
          budgets: {
            depth,
            maxDepth: cfg.maxDepth ?? DEFAULT_MAX_DEPTH,
            fanout: cfg.maxFanout ?? 100,
            // Gate (b), TWO counts. `fanout` (above, `orchestrator.maxAgents`) counts
            // every child this parent EVER had, finished ones too, bar guardian judge
            // consults and plugin hook agents (F1.739, F1.1047): `child-session-fanout-limit`.
            // `concurrency` (below) is the DURABLE backstop over STARTING or RUNNING
            // children regardless of scope, so either scoped ceiling would refuse the
            // other scope's spawns once one filled up — a workflow stage dying beside
            // a subagent fan-out. The sum plus internal headroom keeps it strictly
            // above every legitimate mix, which makes gate (a) the first speaker and
            // keeps `:902`'s never-blocked fork true through the host too.
            concurrency: childSessionConcurrencyBackstop({
              subagentCeiling: maxConcurrentSubagents(),
              workflowCeiling: computeEffectiveConcurrency(cfg.concurrency),
            }),
            tokenLimit: cfg.tokenBudget ?? 100_000,
            costLimitUsd: cfg.costBudgetUsd ?? 100,
            deadlineAt: Date.now() + (cfg.timeoutMs ?? 30 * 60_000),
            ancestry: [...(cfg.ancestry ?? [])],
          },
          requestedAgentId,
        }, args.signal)
        if (result === null) return failure(args.agentDef.name, 'aborted', 'aborted')
        if (args.signal?.aborted) {
          await cfg.childSessionPort.stop(result.agentId).catch(() => {})
          // The child was admitted and may already have produced work; keep it.
          return failure(args.agentDef.name, 'aborted', 'aborted', result.result ?? result.output)
        }
        args.onAdmitted?.(result.agentId)
        const completed = background && ['starting', 'running'].includes(result.status)
          ? await monitorWithAbort(cfg.childSessionPort, result.agentId, args.signal)
          : result
        if (completed === null) return failure(args.agentDef.name, 'aborted', 'aborted')
        return {
          agent: args.agentDef.name,
          agentId: completed.agentId,
          ...(completed.worktreeLeaseId ? { worktreeLeaseId: completed.worktreeLeaseId } : {}),
          status: completed.status === 'failed' ? 'error' : completed.status === 'stopped' || completed.status === 'interrupted' ? 'aborted' : 'done',
          text: completed.result ?? completed.output,
          tokensIn: completed.inputTokens ?? 0,
          tokensOut: completed.outputTokens ?? 0,
          ...(completed.costUsd === undefined ? {} : { costUsd: completed.costUsd }),
          ...(completed.error ? { error: completed.error } : {}),
          ...(completed.turnLimitReached ? { turnLimitReached: true as const } : {}), // F1.225
        }
      } catch (error) {
        if (args.signal?.aborted) return failure(args.agentDef.name, 'aborted', 'aborted')
        // Above the retry arm on purpose: a spending ceiling is not a transient,
        // and three attempts against it would be three refusals and two waits.
        // The partial-text recovery below is skipped too — the cap refuses
        // before admission, so there is no child holding work. This arm is the
        // ONLY place the cap speaks here, and it speaks for every `limitScope`
        // alike, because every scope's spawn goes through the same `start`.
        if (isBudgetExhaustedError(error)) return failure(args.agentDef.name, BUDGET_EXHAUSTED_SPAWN_MESSAGE)
        // P6.237 — the same arm, the other non-retryable host refusal. Checked
        // beside the cap rather than after the retry test, because retrying a
        // managed-policy refusal is three refusals and two waits.
        if (isAgentViewDisabledError(error)) return failure(args.agentDef.name, AGENT_VIEW_DISABLED_SPAWN_MESSAGE)
        if (attempt < MAX_ATTEMPTS && isRateLimitError(error)) {
          // Read HERE, per attempt — see the reader's comment on SpawnerRuntime.
          await delay((cfg.retryBaseDelayMs?.() ?? DEFAULT_SPAWN_RETRY_BASE_DELAY_MS) * 2 ** (attempt - 1), args.signal)
          continue
        }
        return failure(
          args.agentDef.name,
          error instanceof Error ? error.message : String(error),
          'error',
          await recoverPartialText(cfg.childSessionPort, requestedAgentId),
        )
      }
    }
    return failure(args.agentDef.name, 'Child session failed')
  }

  // Declared on every shape this spawn can end in — a substituted model is a
  // fact about the run, not about whether it succeeded.
  const declaringSubstitution = (result: ChildSessionResult): ChildSessionResult =>
    modelSubstitution ? { ...result, modelSubstitution } : result

  try {
    // The slot is held for the child's WHOLE life, not just its start: the body
    // above awaits `monitor` for a background child, so the promise settles when
    // the child does. `sub-agents.md:898` counts subagents that are "running".
    if (holdsSubagentSlot) {
      runningSubagents += 1
      try {
        return declaringSubstitution(await runSpawn())
      } finally {
        runningSubagents -= 1
      }
    }
    return declaringSubstitution(await semaphore.run(runSpawn, args.signal))
  } catch (error) {
    if (args.signal?.aborted || (error instanceof Error && error.message === 'aborted')) {
      return declaringSubstitution(failure(args.agentDef.name, 'aborted', 'aborted'))
    }
    return declaringSubstitution(failure(args.agentDef.name, error instanceof Error ? error.message : String(error)))
  }
}

/**
 * Normalised failure shape. `text` used to be hardcoded empty, which discarded
 * output the spawner was already holding — an abort landing after the child had
 * been admitted and had produced work. Callers pass whatever partial text they
 * have; the failure shape is otherwise unchanged, so `status` and `error` still
 * travel exactly as before.
 *
 * Bounding and defanging belong to whoever renders this text, not here: the host
 * bounds child output at 64 KiB and the tool paths defang it, and the inline
 * result additionally truncates to 32 KiB.
 */
function failure(
  agent: string,
  error: string,
  status: ChildSessionResult['status'] = 'error',
  text = '',
): ChildSessionResult {
  return { agent, status, text, tokensIn: 0, tokensOut: 0, error }
}

/**
 * The zero-tool refusal's wording, kept beside every other refusal on this path.
 *
 * Shaped on the example `errors.md#agent-would-be-spawned-with-zero-tools`
 * prints — "Agent 'code-reviewer' would be spawned with zero tools — refusing.
 * Its tools list resolved to nothing: unrecognized [Grpe]. Fix the agent's tools
 * frontmatter or pass a different subagent_type." — with one deliberate
 * difference. That page groups the entries THREE ways (unrecognized, not
 * available to subagents, matched no tools in this session) and we can honestly
 * tell only TWO apart: a name our resolver could not match at all, and a tool
 * that matched and was then withheld from every subagent. Collapsing the two
 * the resolver cannot separate is the smaller lie than inventing a group
 * boundary, and the author's next move is the same for both — correct the entry
 * or drop it.
 *
 * Both groups are named, never counted: the whole point of refusing instead of
 * launching is that someone can read which entry was wrong.
 */
function zeroToolRefusalMessage(
  agent: string,
  verdict: { unmatched: readonly string[]; withheld: readonly string[] },
): string {
  const groups: string[] = []
  if (verdict.unmatched.length > 0) groups.push(`matched no tool in this session [${verdict.unmatched.join(', ')}]`)
  if (verdict.withheld.length > 0) groups.push(`withheld from every subagent [${verdict.withheld.join(', ')}]`)
  return `Agent '${agent}' would be spawned with zero tools — refusing. `
    + `Its tools list resolved to nothing: ${groups.join('; ')}. `
    + "Fix the agent's tools frontmatter or pass a different subagent_type."
}

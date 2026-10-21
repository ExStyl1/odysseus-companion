import type { AgentMemoryScope } from '../../agents/definitions.ts'
import type { SubagentComponentHooks } from '../../capabilities/component-hooks.ts'
import type { AgentRuntimeView } from '../../capabilities/views.ts'
import type { PermissionMode } from '../mode-types.ts'
import type { SessionKey } from '../../sessions/session-key.ts'
import type { ThinkingLevel } from '../thinking-levels.ts'

export interface PiChildBudgetsV1 {
  depth: number
  maxDepth: number
  fanout: number
  concurrency: number
  tokenLimit: number
  costLimitUsd: number
  deadlineAt: number
  ancestry: string[]
}

export interface PiChildRestrictionsV1 {
  prompt: string
  model: string
  /**
   * The child's tool CEILING — and the field is optional because the contract
   * has three states, not two, and this type could only say two of them
   * (P2.301). `errors.md` § *Agent would be spawned with zero tools* keeps the
   * missing key and the empty list apart in one sentence: "Omitting the `tools`
   * field never triggers this refusal. If you leave the `tools` list empty, or
   * `disallowedTools` removes every entry in it, Claude Code also skips the
   * refusal and launches the subagent without tools." — and its fix list spells
   * out what the omission buys: "Delete the `tools` field instead of listing
   * tools to give the subagent every tool available to subagents".
   * `sub-agents.md` § *Supported frontmatter fields* states the positive half in
   * the `tools` row: "Inherits every tool available to subagents if omitted."
   *
   *  - ABSENT  => no ceiling; inherit the parent pool.
   *  - `[]`    => the author asked for the empty set; the child can call nothing.
   *  - a list  => that list, intersected with any inherited ceiling.
   *
   * Both layers beneath already read it this way and always did — `piAllowedTools`
   * is fed from `managed.piChildRestrictions?.tools`, and
   * `resolvePiAllowedBindingNames` opens with `if (!allowedToolNames) return null`,
   * null being "no restriction". Required-ness here was the ONLY place in the
   * stack that could not express inheritance, which is why the plugin-hook agent
   * producer had to send `[]` for an agent that meant to inherit.
   *
   * WIRE + PERSISTENCE: this interface is embedded verbatim in
   * `PiChildSessionRecordV1.restrictions` and survives restart. The migration
   * direction is the easy one — absent is the NEW state and every record written
   * before this change carries the key — so an old record still parses and still
   * means exactly what it meant.
   */
  tools?: string[]
  thinkingLevel: ThinkingLevel
  /**
   * Marks this child as a CONVERSATION FORK (sub-agents.md:1004): it inherits
   * the parent's message history, system prompt, tools and model instead of
   * starting fresh. Persisted on the record because three consumers need it
   * after the start call returns:
   *  - `startPiChildRuntime` turns it into the `createSession` branch options;
   *  - the child's backend config carries it so the child's own spawner knows
   *    it is a fork and refuses to fork again (:1052);
   *  - both survive a restart, so a resumed fork does not become an ordinary
   *    child.
   * The host re-validates it on `start`; a transport caller cannot use it to
   * widen anything, because a fork carries no permission mode of its own.
   */
  fork?: true
  /** Nessy-resolved agent/profile policy. Transport callers cannot supply paths. */
  worktreePolicy: 'shared' | 'isolated-worktree'
  /**
   * Optional upper bound on how many turns (initial + resumes) the child may
   * run. Positive integer; omitted means unbounded by this field. Enforced
   * host-side; the host only ever narrows it against an inherited bound.
   */
  maxTurns?: number
  /**
   * Optional requested permission mode for the child, as an internal mode key.
   * The host CLAMPS it to be no broader than the parent session's mode before
   * the child session is created; omitted means inherit the parent's mode.
   * Transport callers cannot widen the parent ceiling.
   */
  permissionMode?: PermissionMode
  /** Immutable runtime-agent identity; the host rejects stale generations. */
  capabilityGeneration?: string
  definitionKey?: string
  definitionDigest?: string
  skillKeys?: string[]
  mcpServerKeys?: string[]
  /**
   * The agent definition's `memory:` scope (sub-agents.md:517-519), forwarded so
   * the host can provision the per-agent directory, inject its `MEMORY.md`
   * excerpt and grant Read/Write/Edit (:523-527). Omitted when the definition
   * declares none, so a child request from an agent without memory stays
   * byte-identical to what it was before this field existed.
   *
   * NOT a call-site input: the host re-derives it from the PINNED definition and
   * rejects any value that disagrees (`runtime-agent-memory-unavailable`), so a
   * transport caller cannot use it to unlock the write grant.
   *
   * WIRE + PERSISTENCE: this interface is embedded verbatim in
   * `PiChildSessionRecordV1.restrictions` and survives restart, so records
   * written before the field existed must keep parsing with it absent.
   */
  memory?: AgentMemoryScope
  /**
   * Present when this child is a SKILL FORK — a `context: fork` skill whose body
   * is the child's task (`skills.md:569`, "The skill content becomes the prompt
   * that drives the subagent").
   *
   * It carries the skill's NAME and nothing else, and it authorises nothing: the
   * one consumer is `forkTranscriptEntry`, which needs a name to label the entry
   * with because a skill fork's `task` is the whole skill body. Without it the
   * only way to tell a skill fork from any other named child is `ownerTaskId`
   * being absent, which is also true of a `/subtask` conversation fork and of
   * every host-run judge.
   *
   * Explicitly NOT `fork: true`: that flag means "inherits the parent's history,
   * prompt, tools and model", and `:569` says a forked skill "won't have access
   * to your conversation history". The host refuses the pair.
   *
   * WIRE + PERSISTENCE: appended LAST for the same reason `memory` was — this
   * interface is embedded verbatim in `PiChildSessionRecordV1.restrictions` and
   * survives restart, so records written before the field existed must keep
   * parsing with it absent.
   */
  skillFork?: { name: string }
  /**
   * R87b — the subagent definition's frontmatter `hooks` (`sub-agents.md` §
   * *Hooks in subagent frontmatter*), partitioned by which session dispatches
   * each tier: `.child` runs inside this child's own session (`PreToolUse`,
   * `PostToolUse`, …) and `.parent` is the `Stop`-converted-to-`SubagentStop`
   * tier the PARENT dispatches when the child returns.
   *
   * NOT a call-site input, exactly like `memory`: it decides which commands
   * execute, so the host REFUSES any transport-supplied value outright and
   * copies the one from the PINNED definition in its place. There is nothing a
   * caller could legitimately put here — the spawner never sets it.
   *
   * WIRE + PERSISTENCE: appended LAST for the same reason `memory` and
   * `skillFork` were — this interface is embedded verbatim in
   * `PiChildSessionRecordV1.restrictions` and survives restart, so records
   * written before the field existed must keep parsing with it absent.
   */
  componentHooks?: SubagentComponentHooks
  /**
   * P2.402 — the PRODUCER's half of P2.385: the union of every skill this child
   * is PRELOADED with `disallowed-tools`, collected in the PARENT at spawn time
   * so the child's own gate finally has something to subtract.
   *
   * SESSION-scoped for the child, not turn-scoped, and the two pages say why
   * together: `skills.md#frontmatter-reference` removes the tools "while this
   * skill is active", and `sub-agents.md#preload-skills-into-subagents` says
   * "The full content of each listed skill is injected into the subagent's
   * context at startup" — no message invoked the skill, so no message un-invokes
   * it.
   *
   * It has to TRAVEL because nothing downstream can re-derive it:
   * `RuntimeSkillHandle` pins `allowed-tools` and NOT `disallowed-tools`, so
   * these names exist only in the parent's `skillInvocations`, at spawn time.
   *
   * Written UNCONDITIONALLY, not only for a ceiling-less child. With a ceiling
   * the host already subtracted these names from {@link tools}, so the child's
   * install is a redundant idempotent subtraction; WITHOUT one it is the only
   * thing enforcing the author's removal, because a positive NAME list cannot
   * express "everything except X". One code path beats two whose difference
   * nobody can see.
   *
   * NOT a call-site input and not a ceiling: it can only ever REMOVE, so a
   * transport caller cannot widen anything with it. Pi-only downstream, on
   * purpose — `claude-runtime-agents.ts` merges the same names into
   * `AgentDefinition.disallowedTools`, an agent-LIFETIME field the SDK enforces,
   * and projecting it onto that route as well would double-apply.
   *
   * WIRE + PERSISTENCE: appended LAST for the same reason `memory`, `skillFork`
   * and `componentHooks` were — this interface is embedded verbatim in
   * `PiChildSessionRecordV1.restrictions` and survives restart, so records
   * written before the field existed must keep parsing with it absent.
   */
  skillDisallowedTools?: string[]
}

export type PiChildStatusV1 = 'starting' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export interface PiChildSessionRecordV1 {
  schemaVersion: 1
  agentId: string
  parentSessionKey: SessionKey
  childSessionKey: SessionKey
  agent: string
  task: string
  ownerTaskId?: string
  backgroundTaskId?: string
  background: boolean
  restrictions: PiChildRestrictionsV1
  budgets: PiChildBudgetsV1
  capabilityView?: AgentRuntimeView
  capabilitySnapshotGeneration?: string
  transcriptId?: string
  worktreeLeaseId?: string
  status: PiChildStatusV1
  output: string
  result?: string
  error?: string
  terminalEventEmitted?: boolean
  ownerTaskCompletionEmitted?: boolean
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  /** LEGACY — written by nothing since F1.224 (it fed a resume bound; F1.83 bounds each run). */
  turnsUsed?: number
  /**
   * F1.225 — the LATEST run stopped at its `maxTurns` cap, so its output is partial
   * and the child can be resumed (`sub-agents.md#resume-subagents`). Absent otherwise.
   */
  turnLimitReached?: true
  /**
   * R48 (tools-reference.md:449 — the WebSearch cap is "counted across the
   * main conversation and every subagent it spawns"): the session-tree
   * WebSearch count at the moment this child was spawned. It seeds the child
   * subprocess's budget so the tree shares ONE cap. Absent on legacy records
   * and on children of hosts that predate the budget => seed 0.
   */
  webSearchesUsed?: number
  /**
   * WebSearch calls this child's own subtree consumed (its local calls plus
   * its children's folded consumption; never the inherited seed). Written from
   * the child runtime's terminal report and added to the PARENT subprocess's
   * budget when the result crosses back. Absent => 0 consumed.
   */
  webSearchesConsumed?: number
  createdAt: number
  updatedAt: number
}

export interface PiChildSessionStateV1 {
  schemaVersion: 1
  revision: number
  sealedOwnerTaskIds: string[]
  children: PiChildSessionRecordV1[]
}

export interface PiChildStartInput {
  agent: string
  task: string
  ownerTaskId?: string
  backgroundTaskId?: string
  background: boolean
  restrictions: PiChildRestrictionsV1
  budgets: PiChildBudgetsV1
  requestedAgentId?: string
  /** Trusted host projection; transport callers cannot select or widen it. */
  capabilityView?: AgentRuntimeView
  /** Trusted EffectiveCapabilitySnapshot identity captured by the host. */
  capabilitySnapshotGeneration?: string
  /**
   * R48: the spawning session's WebSearch tree count at spawn time; seeds the
   * child so the tree shares one cap (tools-reference.md:449). Optional for
   * old callers; a supplied value can only NARROW the child's headroom, never
   * widen the cap. Deliberately NOT on `PiChildBudgetsV1` — the budgets shape
   * is copied verbatim onto every persisted record and validated as a block.
   */
  webSearchesUsed?: number
}

export interface PiChildResult {
  agentId: string
  ownerTaskId?: string
  backgroundTaskId?: string
  worktreeLeaseId?: string
  status: PiChildStatusV1
  output: string
  result?: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  /**
   * R48: WebSearch calls this child's subtree consumed (a delta, never the inherited seed),
   * added to the parent's budget; results are re-readable, so fold the per-child maximum.
   */
  webSearchesConsumed?: number
  /** F1.225 — see {@link PiChildSessionRecordV1.turnLimitReached}. */
  turnLimitReached?: true
}

export interface PiChildSearchResult {
  agentId: string
  cursor: number
  status: PiChildStatusV1
  results: string[]
}

export interface PiChildAttachResult {
  agentId: string
  cursor: number
  output: string
  status: PiChildStatusV1
}

export interface PiChildSessionPort {
  start(input: PiChildStartInput): Promise<PiChildResult>
  resume(agentId: string, input: string): Promise<PiChildResult>
  steer(agentId: string, message: string): Promise<void>
  getResult(agentId: string, options?: { wait?: boolean; verbose?: boolean }): Promise<PiChildResult>
  stop(agentId: string): Promise<void>
  stopTask(taskId: string): Promise<void>
  sealOwnerTask(ownerTaskId: string): Promise<void>
  searchOutput(agentId: string, query: string): Promise<PiChildSearchResult>
  attach(agentId: string, cursor?: number): Promise<PiChildAttachResult>
  monitor(agentId: string): Promise<PiChildResult>
}

export type PiChildSessionRequest =
  | { operation: 'start'; input: PiChildStartInput }
  | { operation: 'resume'; agentId: string; input: string }
  | { operation: 'steer'; agentId: string; message: string }
  | { operation: 'get_result'; agentId: string; wait?: boolean; verbose?: boolean }
  | { operation: 'stop'; agentId: string }
  | { operation: 'stop_task'; taskId: string }
  | { operation: 'seal_owner_task'; ownerTaskId: string }
  | { operation: 'search_output'; agentId: string; query: string }
  | { operation: 'attach'; agentId: string; cursor?: number }
  | { operation: 'monitor'; agentId: string }

export type PiChildSessionResponse = PiChildResult | PiChildSearchResult | PiChildAttachResult | void

export function intersectAgentRuntimeView(current: AgentRuntimeView, ceiling: AgentRuntimeView): AgentRuntimeView {
  const keep = <T extends { key: string }>(values: T[], allowed: T[]): T[] => {
    const keys = new Set(allowed.map(value => value.key))
    return values.filter(value => keys.has(value.key))
  }
  return {
    generation: current.generation,
    sources: keep(current.sources, ceiling.sources),
    skills: keep(current.skills, ceiling.skills),
    mcpServers: keep(current.mcpServers, ceiling.mcpServers),
    hooks: keep(current.hooks, ceiling.hooks),
    automations: keep(current.automations, ceiling.automations),
    agents: keep(current.agents, ceiling.agents),
    promptLayers: keep(current.promptLayers, ceiling.promptLayers),
    memory: keep(current.memory, ceiling.memory),
    permissionLayers: keep(current.permissionLayers, ceiling.permissionLayers),
    commands: keep(current.commands, ceiling.commands),
    promptCommands: keep(current.promptCommands, ceiling.promptCommands),
    apps: keep(current.apps, ceiling.apps),
  }
}

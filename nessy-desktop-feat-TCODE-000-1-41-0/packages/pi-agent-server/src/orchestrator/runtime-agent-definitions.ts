import { BUILTIN_AGENT_NAMES, type AgentDefinition } from '../../../shared/src/agents/definitions.ts'
import {
  PI_RUNTIME_AGENT_TOOL_ALIASES,
  SUBAGENT_UNAVAILABLE_TOOLS,
  isAlwaysAvailableSubagentTool,
  subagentRosterToolGrant,
  isReadOnlySubagentToolGrant,
  parseMcpServerLevelGrant,
  reduceDeclaredSubagentToolEntry,
  type PiRuntimeAgentDefinitionDescriptor,
} from '../../../shared/src/agent/pi-harness/runtime-agent-definition.ts'

const BUILTIN_AGENT_NAME_SET = new Set(BUILTIN_AGENT_NAMES)

/**
 * Orchestration tools withheld from a TOOL-LESS descriptor's inherited ceiling.
 *
 * `subagent` is the one member whose withhold is DEPTH-DERIVED rather than
 * unconditional, on BOTH branches below. sub-agents.md:867 — "By default, a
 * subagent can spawn subagents of its own, up to three layers below the main
 * conversation. At the depth limit, Claude Code withholds the `Agent` tool from
 * every subagent except a fork" — and :331 puts the same rule in the tool-list
 * filter, "even when listed in the `tools` field". So below the limit the
 * inherited pool keeps `subagent` and an explicit request is honoured; at the
 * limit both are withheld. A FORK never passes through this builder — its pool
 * is the session's own (`composeForkRestrictions` in `spawner.ts`) — so a fork
 * at the limit keeps the tool listed and the spawner's runtime depth error is
 * its enforcement.
 *
 * The other five stay withheld from the inherited ceiling at every depth (a
 * descriptor that names one explicitly still gets it): without that, an
 * imported agent that declared no `tools` inherited the parent's whole manifest
 * and could steer the parent's children and stop its background tasks. No doc
 * sentence binds them to the depth limit.
 *
 * Deliberately NOT added to `READ_ONLY_SUBAGENT_TOOLS` (shared): `toolset`
 * decides `worktreePolicy` (`spawner.ts`: 'full' => isolated-worktree, otherwise
 * 'shared'), so moving one would flip an agent out of its isolated worktree and
 * into the live tree. Since P8 that set is read against the DECLARED list, so
 * adding one here would relax an agent whose author NAMED it — a widening, and
 * on the host side too, since both sides read the one rule.
 */
const ORCHESTRATION_TOOLS = new Set([
  'subagent',
  'review',
  'get_subagent_result',
  'steer_subagent',
  'stopTask',
  'workflow',
])

// `SUBAGENT_UNAVAILABLE_TOOLS` — `ask_user`, never reaching a subagent whether
// inherited or explicitly requested. Unlike `ORCHESTRATION_TOOLS`, an explicit
// request is denied by omission too (dropping the tool, not rejecting the
// agent), matching how recognized external capabilities without a Pi counterpart
// are handled below. It lives in the shared module since P3.232, because the
// markdown/JSON fallback loader in `agents/definitions.ts` reads the same agent
// files and has to answer this the same way.

/**
 * The tools an author's `tools` list may not remove — R20's four task tools plus
 * R27a's `ReportFindings`. The list, its documentation and the spelling rule all
 * live in the shared module both sides of the Pi boundary read
 * ({@link isAlwaysAvailableSubagentTool}); the host's arrival check consults the
 * same predicate, because a tool that is always available is by construction
 * absent from the DECLARED list that check validates against.
 *
 * Q10-2: this filter used to compare the documented spelling (`TaskCreate`)
 * against a pool that carries piNames (`mcp__session__TaskCreate`) and so
 * matched nothing at all in a real session.
 */
function alwaysAvailableTools(availableToolNames: readonly string[]): string[] {
  return availableToolNames.filter(isAlwaysAvailableSubagentTool)
}

/**
 * Expand a SERVER-LEVEL MCP grant against this session's live pool.
 *
 * sub-agents.md § *Available tools*: "Both fields accept MCP server-level
 * patterns in addition to exact tool names: `mcp__<server>` or
 * `mcp__<server>__*` grants or removes every tool from the named server."
 * `mcp.md` fixes the concrete name the pattern is measured against:
 * "`mcp__<server>__<tool>` … Use this full name when referencing the tool in
 * permission rules, a skill's `allowed-tools` list, a subagent's `tools` field".
 *
 * The pool is already here, which is why this needed no new plumbing across the
 * Pi boundary: `availableToolNames` is `manifest.tools.map(t =>
 * t.binding.piName)` plus `manifest.deferredMcp.candidatePiNames` (`index.ts`),
 * so every external MCP proxy name in the session — deferred ones included —
 * is in this list under exactly the `mcp__<wireName>__<toolName>` spelling
 * `tryParsePiDynamicMcpBindingName` parses.
 *
 * `parseMcpServerLevelGrant` (shared, read by both sides of the boundary) owns
 * which entries are server-level at all: it rejects `mcp__*`, `mcp__*__*` and a
 * bare `*`, rejects a server segment containing `__`, and reserves
 * `mcp__session__` for Nessy's own tools. The trailing `__` in the prefix here
 * is the other half — `mcp__git__` cannot admit `mcp__github__create_issue`.
 *
 * An unknown server yields an empty list, and the caller then treats the entry
 * exactly as it treats any other unresolvable one: denied by omission, named on
 * the debug channel, never thrown on. Widening is impossible in either
 * direction — every returned name was already in the pool.
 */
function expandMcpServerLevelGrant(
  name: string,
  availableToolNames: readonly string[],
): string[] {
  const server = parseMcpServerLevelGrant(name)
  if (!server) return []
  const prefix = `mcp__${server}__`
  return availableToolNames.filter(tool => tool.toLowerCase().startsWith(prefix))
}

/** Exact, then case-insensitive, then through the external-name alias table. */
function resolveToolName(
  name: string,
  exact: ReadonlySet<string>,
  byLower: ReadonlyMap<string, string>,
): string | undefined {
  if (exact.has(name)) return name
  const lower = name.toLowerCase()
  const caseInsensitive = byLower.get(lower)
  if (caseInsensitive) return caseInsensitive
  for (const candidate of PI_RUNTIME_AGENT_TOOL_ALIASES[lower] ?? []) {
    if (exact.has(candidate)) return candidate
    const caseInsensitiveCandidate = byLower.get(candidate.toLowerCase())
    if (caseInsensitiveCandidate) return caseInsensitiveCandidate
  }
  return undefined
}

/**
 * Resolve a descriptor's declared `tools` list against this session's manifest.
 * Total: an entry this runtime cannot honour is DROPPED, never thrown on.
 *
 * The throw this replaced (`Unavailable runtime agent tool(s): …`) was not
 * scoped to the agent that carried the entry. This builder maps a session's
 * whole imported set inside `buildSessionDefinition` (`index.ts`), so one
 * unresolvable entry in one installed plugin's agent took every turn of every
 * session with it — measured live on the signed 1.25.0, where installing the
 * official `claude-security` plugin broke every Pi turn and uninstalling it
 * restored them, on the Pi path only.
 *
 * errors.md § *Agent would be spawned with zero tools* is the contract: "Every
 * entry in the subagent's `tools` list failed to match a usable tool, so Claude
 * Code refused to launch the subagent" — the refusal needs EVERY entry to fail,
 * it names the entries, and it costs ONE launch ("pass a different
 * subagent_type"), never the conversation. An entry that "matches no tool name"
 * is dropped from the list. Dropping keeps the fail-closed property that
 * matters — an unresolved name grants NOTHING, and is never widened into a
 * broader tool — while a session-fatal throw was never a safety property.
 *
 * (Not implemented here: the "spawned with zero tools" refusal itself. It is a
 * spawn-time diagnostic, and this builder cannot refuse a spawn.)
 */
function resolveExplicitTools(
  requested: readonly string[],
  availableToolNames: readonly string[],
  subagentAtLimit: boolean,
): { tools: string[]; unresolved: string[]; withheld: string[] } {
  const exact = new Set(availableToolNames)
  const byLower = new Map(availableToolNames.map(name => [name.toLowerCase(), name]))
  const unresolved: string[] = []
  const resolved = requested.flatMap(rawName => {
    const name = rawName.trim()
    if (!name) return []
    // The parametrized-shape rule, read from the shared module both loaders now
    // consult (P3.232): a name the manifest advertises verbatim is never re-read
    // as parametrized, `Agent(a, b)` reduces to its bare tool, and every other
    // `Tool(specifier)` is denied by omission — the same posture this builder
    // takes for a recognized capability with no Pi counterpart.
    const reduced = reduceDeclaredSubagentToolEntry(name, exact.has(name))
    if ('denied' in reduced) {
      unresolved.push(name)
      return []
    }
    const tool = resolveToolName(reduced.name, exact, byLower)
    if (tool) return [tool]
    // Only once no advertised name matches: a server-level MCP pattern. An
    // exact pool name always outranks a pattern — `mcp__tool_search` and
    // `mcp__tool_load` are real one-separator pool names that also fit the bare
    // `mcp__<server>` shape — which is the same precedence the parametrized
    // form gets above.
    const serverTools = expandMcpServerLevelGrant(name, availableToolNames)
    if (serverTools.length > 0) return serverTools
    // A recognized external capability with no Pi counterpart in this manifest,
    // an unrecognized name, and a server-level pattern naming a server this
    // session does not carry, are all denied by omission. Substituting a
    // broader tool would grant authority; rejecting the imported agent — or,
    // as this did, the session — breaks an otherwise usable chat.
    unresolved.push(name)
    return []
  })
  // sub-agents.md:331 — the first clause removes "`Agent`, when the subagent is
  // at the depth limit", "even when listed in the `tools` field". Dropped by
  // omission, not rejected: below the limit the request is honoured.
  const granted = (tool: string): boolean => !SUBAGENT_UNAVAILABLE_TOOLS.has(tool)
    && !(tool === 'subagent' && subagentAtLimit)
  const distinct = [...new Set(resolved)]
  return {
    tools: distinct.filter(granted),
    unresolved,
    // The same two withholds, reported rather than silently subtracted. They are
    // errors.md's second and third groups — "the entry names a real tool that
    // subagents can't use" and "`Agent` for a subagent at the depth limit" — and
    // that page counts both toward the zero-tools refusal, so a list that
    // resolves ONLY to withheld tools has to be distinguishable from one that
    // resolved to nothing at all. Still not logged by `reportUnresolvedTools`:
    // a withhold on a healthy session is policy, not a defect.
    withheld: distinct.filter(tool => !granted(tool)),
  }
}

/**
 * The depth budget the `subagent` withhold derives from — the same two numbers
 * the spawner's gate reads (`sessionDepth` via `getDepth`, `maxDepth` via
 * `orchestrator.depth`), so the withhold and the refusal cannot disagree.
 */
export interface PiRuntimeAgentDepthBudget {
  /** This session's own child-session depth (0 = top-level session). */
  sessionDepth: number
  /** Maximum subagent layers below the main conversation. */
  maxDepth: number
}

export interface PiRuntimeAgentDefinitionsOptions {
  /**
   * The package's `[pi-server]` stderr channel — `debugLog` in `index.ts`, which
   * every other module here takes by injection (`local-tools/tool-wrapper.ts`,
   * `onDebug` on the spawner). stdout is the JSONL protocol and must not be
   * written to, so this is the only channel available to a builder that cannot
   * reach the transcript.
   *
   * Absent in tests and on the validate path, where nothing is listening.
   */
  debugLog?: (message: string) => void
}

/**
 * Report the entries a descriptor's `tools` list lost, once per agent that lost
 * any — because deny-by-omission and deny-in-silence are not the same thing.
 *
 * errors.md § *Agent would be spawned with zero tools* names the failing entries
 * in Claude's own refusal ("Every entry in the subagent's `tools` list failed to
 * match a usable tool"); we drop instead of refusing, so the naming has to happen
 * here or a grant vanishes with nothing to look at. Live precedent: the official
 * `claude-security` plugin's agents lost their whole subagent grant to a shredded
 * `Agent(a, b)` entry, and the only visible symptom was an agent that never
 * called the tool it was written around.
 *
 * Scoped to entries that FAILED TO RESOLVE. The two documented withholds —
 * `ask_user` (never available to a subagent) and `subagent` at the depth limit —
 * are policy applied to a tool that resolved fine, they fire on healthy sessions,
 * and logging them would make this chatty enough to be ignored. The builder runs
 * per session init and per working-directory switch, so one line per affected
 * agent is the budget; an all-resolving session says nothing at all.
 *
 * Names only. `descriptor.key` is path-free by construction on both routes (a
 * plugin key, or `qualifiedKey`'s scope tuple over an opaque `ProjectKey`), and
 * it is the identifier this module's sibling diagnostic already uses.
 */
function reportUnresolvedTools(
  descriptor: PiRuntimeAgentDefinitionDescriptor,
  unresolved: readonly string[],
  debugLog: ((message: string) => void) | undefined,
): void {
  if (!debugLog || unresolved.length === 0) return
  debugLog(
    `Imported agent ${descriptor.key}: ${unresolved.length} declared tool `
    + `${unresolved.length === 1 ? 'entry' : 'entries'} matched no tool in this `
    + `session's manifest and ${unresolved.length === 1 ? 'was' : 'were'} denied `
    + `by omission: ${unresolved.join(', ')}`,
  )
}

/** Convert validated, path-free host descriptors into existing Pi agent defs. */
export function buildPiRuntimeAgentDefinitions(
  descriptors: readonly PiRuntimeAgentDefinitionDescriptor[] | undefined,
  availableToolNames: readonly string[],
  expectedGeneration: string | undefined,
  depthBudget: PiRuntimeAgentDepthBudget,
  options: PiRuntimeAgentDefinitionsOptions = {},
): readonly AgentDefinition[] {
  const allAvailableTools = [...new Set(availableToolNames)]
  // A subagent built from these definitions runs one layer below this session —
  // the same arithmetic as the spawner's gate (`(args.depth ?? 0) + 1`). It is
  // AT the depth limit when a spawn of its own would be refused (childDepth + 1
  // exceeding maxDepth, i.e. childDepth >= maxDepth), which is exactly when
  // sub-agents.md:867 withholds the `Agent` tool instead of listing a tool that
  // can only error.
  const childDepth = depthBudget.sessionDepth + 1
  const subagentAtLimit = childDepth >= depthBudget.maxDepth
  return Object.freeze((descriptors ?? []).flatMap(descriptor => {
    // A descriptor stamped for a PREVIOUS capability generation is dropped and
    // NAMED — never session-fatal. This used to throw, and the throw ran inside
    // `buildSessionDefinition`, so one stale descriptor killed the whole
    // session: not the turn that hit it, but EVERY turn after it, for the life
    // of that session, with no way back from the UI.
    //
    // That contradicted the policy the sibling route already states at
    // `SessionManager.ts` (A1): "a malformed definition is skipped and NAMED,
    // never session-fatal — one bad file in ~/.nessy-agent/agents/ used to kill
    // this send path for every session." A STALE definition is the same class
    // of problem as a MALFORMED one and gets the same answer.
    //
    // Measured live 2026-08-14 on a real profile, three independent
    // reproductions plus two controls: any mid-session capability
    // re-registration that bumps `snapshotGeneration` (a source enabled or
    // disabled, a plugin installed) left the init-time descriptors behind, and
    // the next turn died. The precondition was not exotic — a normal installed
    // plugin that ships an agent capability is enough (`claude-security` ships
    // seven, `figma` four). The other half of the fix keeps descriptors fresh
    // across a re-registration so nothing is dropped here in practice; this
    // branch is the floor that stops a drop from becoming a dead session.
    if (expectedGeneration && descriptor.capabilityGeneration !== expectedGeneration) {
      options.debugLog?.(
        `Runtime agent ${descriptor.key} was stamped for capability generation `
        + `${descriptor.capabilityGeneration} and this session is on ${expectedGeneration}; `
        + 'the agent is unavailable this turn rather than failing the session.',
      )
      return []
    }
    const explicit = descriptor.tools
      ? resolveExplicitTools(descriptor.tools, allAvailableTools, subagentAtLimit)
      : undefined
    if (explicit) reportUnresolvedTools(descriptor, explicit.unresolved, options.debugLog)
    // A TOOL-LESS descriptor inherits, and inherits nothing it could lose — there
    // is no declared entry to drop, so there is nothing to report either.
    const tools = explicit?.tools
      ?? allAvailableTools.filter(tool =>
        (tool === 'subagent' ? !subagentAtLimit : !ORCHESTRATION_TOOLS.has(tool))
        && !SUBAGENT_UNAVAILABLE_TOOLS.has(tool))
    // P8 — read off the DECLARED list, not the resolved one. `toolset` is what
    // the spawner turns into `worktreePolicy`, and the host recomputes the same
    // verdict from the pinned definition's declared `tools`
    // (`piRuntimeAgentWorktreePolicy`, the one rule both sides now read). Reading
    // the RESOLVED remainder here made the two disagree for every entry that is
    // declared and does not survive — an unresolvable one, and a withheld one
    // (`ask_user`, `subagent` at the limit) — so Pi sent `shared` where the host
    // expected `isolated-worktree` and the spawn died on
    // `runtime-agent-worktree-policy-mismatch`. Measured shapes:
    // `['Read','Bash(git diff:*)']`, `['Read','CronList']`, `['Read','mcp__<absent>__*']`.
    //
    // It is also the safer of the two readings, which is why the convergence went
    // this way: an author who declared `Write` gets an isolated worktree even
    // when this session cannot honour the grant, where the resolved reading put
    // that agent in the user's live tree.
    const toolset = isReadOnlySubagentToolGrant(descriptor.tools)
      ? 'read-only' as const
      : 'full' as const
    // R20: unioned in AFTER `toolset`, deliberately. `toolset` decides
    // `worktreePolicy` ('full' => isolated worktree), so letting the two
    // non-read-only task tools widen it would move a read-only agent out of the
    // shared tree — the exact trap ORCHESTRATION_TOOLS documents above. (Since
    // P8 `toolset` reads the declared list, so this union cannot reach it at
    // all; the ordering stays because it is the honest expression of the rule.)
    // P6.19 — the ROSTER half, unioned on the same line and for the same reason
    // the five always-available tools are: a tool granted outside the declared
    // list has to be added on BOTH sides of the Pi boundary or it is either
    // silently inert (union here only, host refuses it on arrival) or
    // spawn-fatal (host only, Pi never sends it). `subagentRosterToolGrant`
    // is the one rule; the host's arrival check reads its sibling predicate.
    //
    // Ordering is the same as R20's and carries the same meaning: after
    // `toolset`, which since P8 reads the DECLARED list and cannot be reached
    // from here at all. `list_sessions` is read-only either way, so it could not
    // move a read-only agent out of the shared tree even if it could.
    const effectiveTools = [...new Set([
      ...tools,
      ...alwaysAvailableTools(allAvailableTools),
      ...subagentRosterToolGrant(descriptor.tools, allAvailableTools),
    ])]
    // P6.17 — record, for the spawner, that a DECLARED list resolved to nothing.
    //
    // `errors.md#agent-would-be-spawned-with-zero-tools`: "Every entry in the
    // subagent's `tools` list failed to match a usable tool, so Claude Code
    // refused to launch the subagent: with no tools, it couldn't act." This
    // builder cannot refuse a spawn — its own docblock above says so — but it is
    // the only layer that still knows WHICH entries the author wrote, so it
    // records the verdict and `spawnChildSession` acts on it.
    //
    // THE NON-EMPTY CONDITION IS THE WHOLE ROW, and dropping it would reverse
    // P2.202. The same page, three sentences later: "Omitting the `tools` field
    // never triggers this refusal. If you leave the `tools` list empty, or
    // `disallowedTools` removes every entry in it, Claude Code also skips the
    // refusal and launches the subagent without tools." An omitted field arrives
    // as `undefined` (no `explicit` at all) and an authored-empty one as `[]`
    // (`parseDeclaredTools`' EMPTY_TOOL_LIST) — neither is a refusal. And
    // `disallowedTools` is applied later still, in the spawner's own filter, so a
    // list emptied by a denial never reaches this branch.
    //
    // The always-available task tools are deliberately NOT counted as survivors:
    // `effectiveTools` above unions them in regardless of what the author asked
    // for — R20's four task tools plus R27a's `ReportFindings` — so
    // counting them would make this condition unreachable — measured, every
    // zero-tool shape reached the spawner holding exactly TaskCreate and
    // ReportFindings.
    const declaredEntries = (descriptor.tools ?? []).filter(entry => entry.trim() !== '')
    const zeroToolResolution = explicit && declaredEntries.length > 0 && explicit.tools.length === 0
      ? {
        unmatched: Object.freeze([...explicit.unresolved]),
        withheld: Object.freeze([...explicit.withheld]),
      }
      : undefined
    const hasUnqualifiedAlias = descriptor.selectedAsUnqualifiedAlias
      && !BUILTIN_AGENT_NAME_SET.has(descriptor.name.trim().toLowerCase())
    return [Object.freeze({
      name: hasUnqualifiedAlias ? descriptor.name : descriptor.key,
      aliases: [...new Set([descriptor.key, ...(hasUnqualifiedAlias ? [descriptor.name] : [])])],
      description: descriptor.description || `Imported ${descriptor.name} agent.`,
      systemPrompt: descriptor.systemPrompt,
      toolset,
      tools: Object.freeze(effectiveTools) as unknown as string[],
      ...(zeroToolResolution ? { zeroToolResolution } : {}),
      tier: descriptor.tier ?? 'medium' as const,
      ...(descriptor.model ? { model: descriptor.model } : {}),
      ...(descriptor.disallowedTools ? { disallowedTools: [...descriptor.disallowedTools] } : {}),
      ...(descriptor.effort ? { effort: descriptor.effort } : {}),
      ...(descriptor.maxTurns === undefined ? {} : { maxTurns: descriptor.maxTurns }),
      ...(descriptor.permissionMode ? { permissionMode: descriptor.permissionMode } : {}),
      capabilityGeneration: descriptor.capabilityGeneration,
      definitionKey: descriptor.key,
      definitionDigest: descriptor.definitionDigest,
      // The `/context` subagent rows name the source each definition loaded
      // from; dropping provenance here silently unnames them all.
      provenance: descriptor.provenance,
      ...(descriptor.skillKeys ? { skillKeys: [...descriptor.skillKeys] } : {}),
      ...(descriptor.mcpServerKeys ? { mcpServerKeys: [...descriptor.mcpServerKeys] } : {}),
      ...(descriptor.memory ? { memory: descriptor.memory } : {}),
      ...(descriptor.background === undefined ? {} : { background: descriptor.background }),
      ...(descriptor.color ? { color: descriptor.color } : {}),
      ...(descriptor.isolation ? { isolation: descriptor.isolation } : {}),
    })]
  }))
}

/**
 * F1.478 (origin WJ-rr-b P-WJ-rr-b-1, 2026-09-24) — the SECOND name a Pi session
 * tool's rule request answers to: claude's. The mirror of F1.379, which gave
 * codex's session-tool request Pi's name (`codex-agent.ts`
 * `codexSessionToolPiAlias` / `evaluateCodexRuleRequest`).
 *
 * Pi judges a session tool under its binding's `permissionName` (the handler
 * name, `spawn_session`) and `descriptorId` (`harness-tool-descriptor.ts`
 * `sessionBinding`). Claude is handed the same tool as
 * `mcp__session__spawn_session` — byte-identical to the binding name, which is
 * what the SDK mints for it — and codex projects it under that name too. So a
 * claude-spelled rule (`mcp__session__spawn_session`, `mcp__session`, `mcp__*`)
 * bound on claude and codex and matched NOTHING on Pi.
 *
 * The two names are ONE subject, in F1.379's shape: an ALIAS of the same
 * request, never a second request, and {@link evaluatePermissionDslUnderSessionToolAlias}
 * reads both — a deny or an ask under either wins (deny > ask > allow, the DSL's
 * own order) and an allow under either answers. Never a widening: each name is
 * one another runtime already honours for this call. The alias carries
 * `semanticId: 'mcp_dynamic'`, the pair codex's own primary request carries, so
 * F1.377's rule — a path/host ALLOW never answers an MCP call — holds for it by
 * the same predicate (`isMcpPermissionRequest`).
 *
 * WHICH session tools: the ones claude is handed as `mcp__session__<name>` —
 * every registry definition that is not `visibility: 'pi-only'`, the declaration
 * F1.74's `sessionToolGateName` (`core/pre-tool-use.ts`) reads for the mode
 * gate. A `pi-only` tool is one claude never receives from us (it runs its own
 * built-in of that name, e.g. `EnterWorktree`, `TaskList`), so a claude-spelled
 * `mcp__*` does not reach it there and does not here. The consequence, stated:
 * `deny mcp__*` now reaches Pi's `TodoWrite`, `SubmitPlan` and every other
 * claude-visible session tool, exactly as it reaches them on claude.
 *
 * A failed document answers under both names alike: `stale-generation` and
 * `invalid-policy` do not depend on the tool name, so the merge returns the same
 * fail-closed deny the primary alone would have.
 */
import { SESSION_TOOL_DEFS } from '@nessy-agent/session-tools-core'

import {
  evaluatePermissionDslV1,
  filterCapabilityIdentitiesByWholeToolDeny,
  permissionDslDenyReason,
  permissionDslInvalidPolicyDeny,
  type CapabilityIdentityForDenyFilter,
  type CompiledPermissionDslV1,
  type PermissionDslEvaluationV1,
  type PermissionDslRequestV1,
} from './permission-dsl.ts'
import type { PiDynamicToolDefinition, ResolvedHarnessTool } from './harness-manifest.ts'
import { PI_BUILTIN_CLAUDE_RULE_NAMES, getHarnessToolDescriptor, getPiToolBindingByBindingName } from './harness-tool-descriptor.ts'

/** Claude's `(toolName, semanticId)` for one Pi session tool call. */
export interface PiSessionToolRuleAlias {
  toolName: string
  semanticId: string
}

let claudeVisibleSessionTools: ReadonlySet<string> | undefined

/**
 * F1.1111 (origin DN-078, the Pi mirror of F1.833) — Pi tools whose Claude counterpart has ANOTHER name, keyed by Pi
 * binding name, valued by Claude's tool name. Only the pairs this fork already records as the same tool in
 * `PI_RUNTIME_AGENT_TOOL_ALIASES` (`runtime-agent-definition.ts`: `glob`, `agent`, `askuserquestion`, `toolsearch`,
 * `listmcpresourcestool`, `readmcpresourcetool`) and F1.833's claude-side `CLAUDE_BUILTIN_PI_COUNTERPARTS`; `ToolSearch`
 * covers both halves Pi splits it into (tools-reference.md: "Searches for and loads deferred tools"). Not here, on
 * purpose: the legacy `Task` (Pi has its own task-graph tool of that name, so a `Task` rule there keeps meaning it)
 * and `LSP` (no recorded equivalence with Pi's `lsp`). A rule under the Claude name is then judged as the same subject
 * (deny > ask > allow), in the gate and in the manifest's whole-tool-deny filter alike.
 */
const PI_BUILTIN_CLAUDE_NAMES: ReadonlyMap<string, string> = PI_BUILTIN_CLAUDE_RULE_NAMES // F1.1083 — the table lives beside PERMISSION_RULE_TOOL_NAMES, which knows its names

/**
 * Claude's name for a Pi binding, or `undefined` for anything that is not a
 * claude-visible session tool or one of {@link PI_BUILTIN_CLAUDE_NAMES}. A session binding is the one whose binding name
 * is `mcp__session__` + its permission name (`sessionBinding`); the built-ins,
 * the orchestrator tools and every proxied MCP tool fail that test.
 */
export function piSessionToolRuleAlias(
  binding: Pick<CapabilityIdentityForDenyFilter, 'bindingName' | 'permissionName'>,
): PiSessionToolRuleAlias | undefined {
  const claudeName = PI_BUILTIN_CLAUDE_NAMES.get(binding.bindingName)
  if (claudeName) return { toolName: claudeName, semanticId: claudeName }
  if (binding.bindingName !== `mcp__session__${binding.permissionName}`) return undefined
  claudeVisibleSessionTools ??= new Set(
    SESSION_TOOL_DEFS.filter(def => def.visibility !== 'pi-only').map(def => def.name),
  )
  return claudeVisibleSessionTools.has(binding.permissionName)
    ? { toolName: binding.bindingName, semanticId: 'mcp_dynamic' }
    : undefined
}

/**
 * One Pi rule request evaluated under BOTH of its names. Without an alias it is
 * exactly `evaluatePermissionDslV1` — except for a session tool that stands in
 * for a built-in ({@link SESSION_TOOL_BUILTIN_STAND_INS}, F1.1072): a whole-tool
 * DENY of that built-in refuses it too.
 */
export function evaluatePermissionDslUnderSessionToolAlias(
  program: CompiledPermissionDslV1,
  alias: PiSessionToolRuleAlias | undefined,
  request: PermissionDslRequestV1,
): PermissionDslEvaluationV1 {
  const answer = mergeUnderAlias(program, alias, request)
  if (answer.action === 'deny') return answer
  const standIn = sessionToolStandInCounterpart(request.toolName) ?? (alias && sessionToolStandInCounterpart(alias.toolName))
  if (!standIn) return answer
  const wholeToolDenies = { ...program, rules: program.rules.filter(rule => rule.action === 'deny' && rule.matcher.kind === 'tool') }
  const denied = evaluatePermissionDslV1(wholeToolDenies, { ...request, ...standIn })
  return denied.action === 'deny' ? denied : answer
}

function mergeUnderAlias(
  program: CompiledPermissionDslV1,
  alias: PiSessionToolRuleAlias | undefined,
  request: PermissionDslRequestV1,
): PermissionDslEvaluationV1 {
  const primary = evaluatePermissionDslV1(program, request)
  if (!alias) return primary
  const both = [primary, evaluatePermissionDslV1(program, { ...request, ...alias })]
  for (const action of ['deny', 'ask', 'allow'] as const) {
    const hit = both.find(evaluation => evaluation.action === action)
    if (hit) return hit
  }
  return primary
}

/**
 * F1.1072 (origin DN-261, 2026-09-28) — the session tools that stand in for a
 * built-in search or fetch tool, keyed by the name claude and codex judge them
 * under, valued by the Pi binding of the built-in they replace.
 *
 * `mcp__session__web_search` is the app's search, handed to claude on a gateway
 * connection (whose hosted `WebSearch` cannot run there) and to codex; Pi keeps
 * its own `web_search` built-in (`visibility: 'not-pi'`). Judged under its own
 * name only, a `WebSearch` deny matched nothing on claude or at codex's consult,
 * so a user who denied web search still got one. permissions.md, MCP section,
 * verbatim: "Claude Code also applies deny rules that name the whole `Bash` or
 * `WebFetch` tool to these Cowork tools" and "Allow rules don't carry over". So
 * a whole-tool DENY of the built-in (a `tool` matcher: `WebSearch`, Pi's
 * `web_search`, or a glob over either, the names F1.1061's codex projection
 * reads, `CODEX_WEB_SEARCH_RULE_NAMES`) refuses the stand-in on every runtime
 * that judges it here; an allow or an ask of the built-in does not carry, and a
 * rule on the stand-in's own name binds as before.
 */
const SESSION_TOOL_BUILTIN_STAND_INS: ReadonlyMap<string, string> = new Map([['mcp__session__web_search', 'web_search']])

function sessionToolStandInCounterpart(toolName: string): PiSessionToolRuleAlias | undefined {
  const builtin = SESSION_TOOL_BUILTIN_STAND_INS.get(toolName)
  const binding = builtin === undefined ? undefined : getPiToolBindingByBindingName(builtin)
  return binding ? { toolName: binding.permissionName, semanticId: binding.descriptorId } : undefined
}

/**
 * F1.1175 (origin the do-now adversarial review, 2026-09-29) — the same carry for
 * the host's `toolRules`, which never enter the readable program the evaluator
 * above reads. The mode gate (`shouldAllowToolInMode`, `mode-manager.ts`) matched
 * them against the literal tool name only, so `{ pattern: 'WebSearch', action:
 * 'deny' }` refused Claude's own `WebSearch` and Pi's `web_search` (whose gate
 * name is `WebSearch`) while the app's `mcp__session__web_search` ran on a Claude
 * gateway session in every mode.
 *
 * `match` is the gate's own first-match reading of the list, asked once per name.
 * The stand-in's own rule decides unless the built-in's gate name (its binding's
 * `permissionName`, the one name a `toolRules` pattern refuses the built-in
 * under) is DENIED: a deny under either name wins, as in
 * {@link evaluatePermissionDslUnderSessionToolAlias}; an allow or an ask of the
 * built-in does not carry, and each name keeps its own first-match order.
 */
export function toolRuleUnderSessionToolStandIn<R extends { readonly action: string }>(
  toolName: string,
  match: (name: string) => R | null,
): R | null {
  const own = match(toolName)
  if (own?.action === 'deny') return own
  const standIn = sessionToolStandInCounterpart(toolName)
  const builtin = standIn ? match(standIn.toolName) : null
  return builtin?.action === 'deny' ? builtin : own
}

/**
 * The advertised half: a whole-tool deny under EITHER name removes the tool from
 * the manifest, so the model is never shown a tool the gate refuses on every
 * call — the agreement `filterCapabilityIdentitiesByWholeToolDeny`'s docblock
 * requires ("removal that disagrees with enforcement is a new defect"). Only
 * ever removes: the claude-named pass runs over what the Pi-named pass kept.
 */
export function filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias<T extends CapabilityIdentityForDenyFilter>(
  identities: readonly T[],
  program: CompiledPermissionDslV1,
): T[] {
  return filterCapabilityIdentitiesByWholeToolDeny(identities, program).filter(identity => {
    const alias = piSessionToolRuleAlias(identity)
    return !alias || filterCapabilityIdentitiesByWholeToolDeny(
      [{ ...identity, permissionName: alias.toolName, semanticId: alias.semanticId }],
      program,
    ).length > 0
  })
}

/**
 * F1.489 (3) (origin WJ-zz P-WJ-zz-3) — the capability identities Pi's execution
 * manifest filters by whole-tool deny: one per static tool (its binding and its
 * descriptor) and one per dynamic tool (its known binding, else the synthesized
 * one `resolveDynamicTool` builds for an unknown name, which uses the binding
 * name as its permissionName — so an MCP proxy tool is judged under the same
 * wire spelling here as at the gate). `buildExecutionManifestForCurrentTurn`
 * (`pi-agent.ts`) and `whole-tool-deny-manifest.test.ts` both call THIS, so the
 * test drives production's derivation rather than a copy of it.
 */
export function piManifestCapabilityIdentities(
  staticTools: readonly Pick<ResolvedHarnessTool, 'binding' | 'descriptor'>[],
  dynamicTools: readonly Pick<PiDynamicToolDefinition, 'bindingName'>[],
): CapabilityIdentityForDenyFilter[] {
  return [
    ...staticTools.map(tool => ({
      bindingName: tool.binding.bindingName,
      piName: tool.binding.piName,
      semanticId: tool.descriptor.id,
      permissionName: tool.binding.permissionName,
    })),
    ...dynamicTools.map(tool => {
      const binding = getPiToolBindingByBindingName(tool.bindingName)
      return {
        bindingName: tool.bindingName,
        piName: binding?.piName ?? tool.bindingName,
        semanticId: getHarnessToolDescriptor(binding?.descriptorId ?? 'mcp_dynamic').id,
        permissionName: binding?.permissionName ?? tool.bindingName,
      }
    }),
  ]
}

/** F1.756 — what the Pi event adapter shows for a call to a whole-tool-denied tool. */
export interface PiWholeToolDenyRefusal {
  /** The name the gate judges the tool under (`permissionName`), for the card. */
  toolName: string
  /** The readable-policy deny sentence, naming the rule and its scope. */
  refusal: string
}

/**
 * F1.756 (origin release sitting SIT-j, 2026-09-25) — for every tool a
 * whole-tool deny rule took out of `manifest`, the refusal naming that rule,
 * keyed by the name the Pi SDK reports for the tool (`piName`).
 *
 * `permissions.md#manage-permissions`, verbatim: "A bare tool name like `Bash`
 * removes the tool from Claude's context entirely, so Claude never sees it. If
 * you add such a rule mid-session, Claude can't call the tool from its next
 * tool call on". {@link filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias}
 * is that removal on Pi. A model that saw the tool before the rule landed (a
 * `tool_search` load earlier in the chat) can still call it; the Pi SDK then
 * answers "Tool <name> not found" on its own, and the host's event adapter,
 * finding no manifest entry, raised an internal-error row, so the refusal never
 * named the rule. With this map the adapter tells the two apart: a name listed
 * here was removed by the rule it names; any other unadvertised name is still
 * an internal fault and still throws.
 *
 * The sentence is the one the gate shows for a denied call
 * (`permissionDslDenyReason`), so the card uses the same spelling every
 * readable-policy refusal uses. The FIRST deny rule, in program order, that
 * removes the tool on its own is named. A policy that failed to compile removes
 * every tool (fail-closed); its sentence is the compiler's own diagnostic, as at
 * the gate. Only tools the manifest does NOT advertise are listed, so the
 * EndConversation exception (kept although a rule names it) never gets an entry.
 */
export function piWholeToolDenyRefusals(
  manifest: { tools: readonly { binding: { piName: string } }[] },
  identities: readonly CapabilityIdentityForDenyFilter[],
  program: CompiledPermissionDslV1 | undefined,
): ReadonlyMap<string, PiWholeToolDenyRefusal> | undefined {
  if (!program) return undefined
  const advertised = new Set(manifest.tools.map(tool => tool.binding.piName))
  const refusals = new Map<string, PiWholeToolDenyRefusal>()
  for (const identity of identities) {
    if (advertised.has(identity.piName) || refusals.has(identity.piName)) continue
    const refusal = wholeToolDenySentence(identity, program)
    if (refusal) refusals.set(identity.piName, { toolName: identity.permissionName, refusal })
  }
  return refusals.size > 0 ? refusals : undefined
}

function wholeToolDenySentence(
  identity: CapabilityIdentityForDenyFilter,
  program: CompiledPermissionDslV1,
): string | undefined {
  if (program.invalidSource) return permissionDslDenyReason(permissionDslInvalidPolicyDeny(program.invalidSource)) // F1.1187
  const rule = program.rules.find(candidate => candidate.action === 'deny'
    && filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias([identity], { ...program, rules: [candidate] }).length === 0)
  if (!rule) return undefined
  return permissionDslDenyReason({
    action: 'deny',
    match: {
      ruleId: rule.id,
      scope: rule.scope,
      sourceDigest: rule.sourceDigest,
      ...(rule.text === undefined ? {} : { ruleText: rule.text }),
    },
  })
}

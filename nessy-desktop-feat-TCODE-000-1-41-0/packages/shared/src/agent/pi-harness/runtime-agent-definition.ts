import { createHash } from 'node:crypto'

import { estimateTokens } from '../../utils/large-response.ts'

import type { CapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts'
import type { AgentRuntimeView } from '../../capabilities/views.ts'
import {
  parseSubagentFrontmatterHooks,
  staticSubagentComponentHooks,
  type SubagentComponentHooks,
} from '../../capabilities/component-hooks.ts'
import { splitMarkdownFrontmatter, splitToolGrantList } from '../../plugins/format-adapters/shared.ts'
import { PI_TOOL_BINDINGS } from './harness-tool-descriptor.ts'
import { matchesToolPattern } from '../mode-manager.ts'
import { parsePermissionMode, type PermissionMode } from '../mode-types.ts'
import { normalizeThinkingLevel, type ThinkingLevel } from '../thinking-levels.ts'
import {
  AGENT_COLORS,
  MAX_AGENT_INITIAL_PROMPT_LENGTH,
  PARAMETRIZED_TOOL_SHAPE,
  SUBAGENT_TOOL_SPELLINGS,
  SUBAGENT_UNAVAILABLE_TOOLS,
  isYamlBlockScalarIndicator,
  reduceDeclaredSubagentToolEntry,
  type AgentColor,
  type AgentIsolation,
  type AgentMemoryScope,
  type AgentTier,
  type SessionAgentDefinitionV1,
} from '../../agents/definitions.ts'

const AGENT_MEMORY_SCOPE_VALUES: readonly AgentMemoryScope[] = ['user', 'project', 'local']

const MAX_RUNTIME_AGENTS = 128
const MAX_AGENT_KEY_LENGTH = 1_024
const MAX_AGENT_NAME_LENGTH = 128
const MAX_AGENT_DESCRIPTION_LENGTH = 4_096
const MAX_AGENT_PROMPT_BYTES = 256 * 1024
const MAX_AGENT_TOOLS = 256
const MAX_AGENT_TOOL_LENGTH = 256

/**
 * The spelling Nessy ADVERTISED for a session tool up to 1.26.0, mapped to the
 * one it advertises now.
 *
 * Until the wire-name unification a session tool's model-facing piName was the
 * snake_case descriptor id (`mcp__session__cron_create`); it is now the registry
 * id verbatim (`mcp__session__CronCreate`), which is what Claude and Codex have
 * always used. An agent or skill whose `tools:` / `disallowed-tools:` was
 * written against the old advertised spelling must keep resolving, and the two
 * failure modes are not symmetric: on the allow side the entry is dropped and
 * the agent silently loses a tool, while on the DENY side the entry stops
 * matching and a denial the author wrote silently stops denying.
 *
 * `resolveToolName` looks the table up BY KEY, so a legacy spelling has to be a
 * key of its own — listing it among another entry's candidates (which the 15
 * hand-written entries below already do) only helps the pool side. Nineteen of
 * the 22 respelled tools need one; `task`, `goal` and `monitor` differ from
 * their registry ids by case alone and the resolver's case-insensitive step
 * already bridges those.
 *
 * Derived from `PI_TOOL_BINDINGS` under the same predicate as the transcript
 * ingress map (`pi-legacy-ingress.ts`) — `bindingName.startsWith('mcp__session__')`
 * AND `descriptorId !== handlerName`, never the second half alone, which also
 * matches the native `notebook_edit`/`stopTask` bindings. Spread FIRST so that
 * any hand-written entry below wins a key collision.
 */
const LEGACY_SESSION_TOOL_SPELLINGS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(PI_TOOL_BINDINGS
    .filter(binding => binding.bindingName.startsWith('mcp__session__')
      && binding.descriptorId !== binding.handlerName)
    .map(binding => [`mcp__session__${binding.descriptorId}`, Object.freeze([binding.piName])])),
)

/**
 * The BARE DOCUMENTED spelling of every respelled session tool — the string
 * `tools-reference.md` opens by telling an author to write ("The tool names are
 * the exact strings you use in permission rules, subagent tool lists, and hook
 * matchers") — mapped onto the three spellings Pi has advertised for it.
 *
 * ## Why this is DERIVED, and it is the second half of a pair
 *
 * {@link LEGACY_SESSION_TOOL_SPELLINGS} is keyed by the `mcp__session__`-PREFIXED
 * legacy spelling only, so it can never reach the bare documented one. Every
 * entry this map now produces used to be hand-written, and the hand-writing has
 * now missed a shipped binding in two consecutive waves — `WorktreeBatch`
 * (`1384f0bcc`, P6.508) and `CronControl` (the wave after R27b), each found by
 * the derived guard in `runtime-agent-definition.test.ts` rather than by anyone
 * noticing. P6.838 replaced the family with this `Object.fromEntries` over the
 * same array the guard reads, so the class cannot recur: a new session binding
 * whose `descriptorId` diverges from its `handlerName` arrives here for free.
 *
 * Measured when the family was folded in (P6.838, 2026-09-08): 24 divergent
 * bindings, 23 of them already carrying a hand-written entry BYTE-IDENTICAL to
 * what this map produces, and exactly one deliberate exception, below.
 *
 * ## What the hand-written entries cost, kept because the reasons are the point
 *
 * Every one of them was written after a shipped defect, and they are all one
 * defect: `resolveExplicitTools` does not SKIP a name it cannot resolve — it
 * pushes it onto `unresolved` and THROWS, so an imported Claude agent whose
 * `tools:` names the tool's own documented spelling is rejected WHOLE. On the
 * DENY side the same gap is silent and worse: `disallowed-tools: [CronList]`
 * matched nothing and denied nothing, the failure class of `1ff71c5a4`,
 * `8cd73fa1c` and `a878817cd`.
 *
 * - R2 — `EnterWorktree`/`ExitWorktree`, the first pair, same shape as `todowrite`.
 * - R20 — the four task tools, which are unioned into every subagent
 *   unconditionally (`SUBAGENT_ALWAYS_AVAILABLE_TOOLS`), so an agent that stayed
 *   silent got them for free while an agent that NAMED one failed to load.
 * - R27a — the three delivery tools: a code-review agent declaring
 *   `tools: [Read, Grep, ReportFindings]`, which is the documented way to write
 *   one, would fail to load entirely.
 * - R27b — the three Cron tools, shipped two hours after R27a and not applying
 *   its lesson; and `Monitor`, whose manifest advertises `mcp__session__Monitor`,
 *   which no case-insensitive match reaches from the bare name.
 * - R39 — `ScheduleWakeup`.
 * - The wire-name unification sweep — `SubmitPlan`, `GoalGet`, `Goal`,
 *   `SlashCommand`, `BashOutput` and `ProcessStop`, six tools the R2/R5/R17/R20/
 *   R27 waves had each left out and that had NO entry at all.
 * - P6.508 / P6.833 — `WorktreeBatch` and `CronControl`, the two that proved the
 *   hand-writing was the defect rather than the omissions.
 *
 * ## The one name this map must NOT own
 *
 * `Task`. The bare `task` key belongs to Claude's SUBAGENT tool
 * (`task: ['subagent']`, in the table below), and the session Task tool is
 * reached by its prefixed name through {@link LEGACY_SESSION_TOOL_SPELLINGS}
 * instead. Spread ORDER is what enforces that: this map goes in FIRST, so the
 * hand-written `task` entry below overwrites its value while the derived
 * position is kept — and `normalizePiRuntimeAgentToolName` reads the value, not
 * the position. The same rule covers any future collision: a hand-written entry
 * always wins.
 */
const DOCUMENTED_SESSION_TOOL_SPELLINGS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(PI_TOOL_BINDINGS
    .filter(binding => binding.bindingName.startsWith('mcp__session__')
      && binding.descriptorId !== binding.handlerName)
    .map(binding => [
      binding.handlerName!.toLowerCase(),
      Object.freeze([
        `mcp__session__${binding.handlerName}`,
        `mcp__session__${binding.descriptorId}`,
        binding.descriptorId,
      ]),
    ])),
)

export const PI_RUNTIME_AGENT_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...LEGACY_SESSION_TOOL_SPELLINGS,
  // P6.838 — the ~14 hand-written bare-spelling entries this used to carry are
  // now derived from the same array. FIRST, so any hand-written key below still
  // wins the collision (`task` is the one that needs it).
  ...DOCUMENTED_SESSION_TOOL_SPELLINGS,
  // Claude Code renamed its subagent tool `Task` → `Agent`; marketplace plugins
  // declare the current name. Both map to the same Pi tool, so recognizing
  // `agent` grants no authority `task` did not already grant — and keeps an
  // unmapped runtime denying it by omission instead of failing the whole turn.
  agent: ['subagent'],
  // R27b: `ask_user` implements Claude's AskUserQuestion. The alias makes a
  // subagent that names it DROP the tool (agent-sdk/user-input.md keeps it off
  // subagents) instead of failing to load at all.
  askuserquestion: ['ask_user'],
  bash: ['bash'],
  edit: ['edit'],
  glob: ['find'],
  grep: ['grep'],
  /**
   * P6.47 — cross-session messaging, the one surface where OUR spelling and the
   * documented one diverge on purpose, and the divergence had never been written
   * down.
   *
   * `cross-session-messaging.md` (intro): "Claude uses two tools for this:
   * `ListAgents` to discover which agents it can reach, and `SendMessage` to
   * deliver a message to one of them by name." Ours are `list_sessions` and
   * `send_agent_message`.
   *
   * **Why we keep our own names rather than renaming to the documented ones.**
   * `SendMessage` already exists in this repo as an unrelated symbol — the RPC
   * that carries the USER's message into a session (`sessions.SEND_MESSAGE`) —
   * and taking that name for a tool would be the "same-named symbols in a
   * sibling subsystem" trap verbatim. `list_sessions` is likewise the honest
   * name: our targets are sessions, not the subagents and teammates upstream's
   * `ListAgents` also enumerates.
   *
   * **Why the alias is nonetheless required.** The page's own off-switch is
   * written in the documented spelling — §Turn off cross-session messaging:
   * "**Stop sending and listing**: add permission deny rules naming
   * `SendMessage` and `ListAgents`. Both take the bare tool name with no
   * specifier." Without an entry here, an imported agent or plugin whose
   * `disallowedTools` names either resolved to nothing and the denial silently
   * stopped denying — the exact failure this table was built for, and the worst
   * class in this fork.
   *
   * The alias grants nothing new: it folds the documented name onto the tool we
   * already advertise, so a denial covers a little more than its author's
   * literal word and never less, and the allow side stops rejecting the whole
   * agent over a name it could not resolve.
   */
  listagents: ['mcp__session__list_sessions', 'list_sessions'],
  listfiles: ['ls'],
  // R5: Claude names the model-facing MCP resource tools `ListMcpResourcesTool`
  // / `ReadMcpResourceTool` in permission rules and agent tool lists. Map both
  // those spellings (and the bare names) onto our session tools so an imported
  // Claude agent's `tools: [ListMcpResourcesTool]` resolves instead of throwing.
  listmcpresources: ['mcp__session__list_mcp_resources', 'list_mcp_resources'],
  listmcpresourcestool: ['mcp__session__list_mcp_resources', 'list_mcp_resources'],
  // R27b: same for the notebook editor — the binding is `notebook_edit`.
  notebookedit: ['notebook_edit'],
  notebookread: ['read'],
  read: ['read'],
  readfile: ['read'],
  readmanyfiles: ['read'],
  readmcpresource: ['mcp__session__read_mcp_resource', 'read_mcp_resource'],
  readmcpresourcetool: ['mcp__session__read_mcp_resource', 'read_mcp_resource'],
  // R17: same shape as the R5 entries above — an agent or a skill's
  // `allowed-tools` naming the resource reader must resolve, not throw.
  readskillresource: ['mcp__session__read_skill_resource', 'read_skill_resource'],
  /** P6.47 — the other half of the `listagents` entry above; the reasoning is there. */
  sendmessage: ['mcp__session__send_agent_message', 'send_agent_message'],
  shell: ['bash'],
  task: ['subagent'],
  // permissions.md:158 — "the tool labeled `Stop Task` in the transcript has
  // the canonical name `TaskStop`". The permission/hook axis now carries
  // `TaskStop` (the stop_task binding's permissionName in
  // harness-tool-descriptor.ts); the binding name Pi dispatches on is still
  // `stopTask`, and this entry covers the remaining axis — agent/skill tool
  // lists — by resolving `TaskStop` (and both spellings) to that binding name.
  taskstop: ['stopTask', 'stop_task'],
  // `todolist` is NOT derivable: `TodoList` is a documented Claude name with no
  // binding of its own, so it stays hand-written beside the derived `todowrite`.
  todolist: ['mcp__session__TodoWrite', 'mcp__session__todo_write', 'todo_write'],
  // R27b: `mcp__tool_search` is our ToolSearch (tool-search.md).
  toolsearch: ['mcp__tool_search'],
  webfetch: ['web_fetch'],
  websearch: ['web_search'],
  write: ['write'],
})

/**
 * P3.232 moved `PARAMETRIZED_TOOL_SHAPE`, `SUBAGENT_TOOL_SPELLINGS`,
 * `SUBAGENT_UNAVAILABLE_TOOLS` and {@link reduceDeclaredSubagentToolEntry} down
 * into `agents/definitions.ts`, which this module already imports and which the
 * OTHER loader of the same agent files lives in. They are re-exported here
 * unchanged because this module is where every reader of them looks; the move is
 * about which module can IMPORT them without a cycle, not about ownership.
 */
export {
  PARAMETRIZED_TOOL_SHAPE,
  SUBAGENT_TOOL_SPELLINGS,
  SUBAGENT_UNAVAILABLE_TOOLS,
  reduceDeclaredSubagentToolEntry,
}

/**
 * `mcp__<server>` / `mcp__<server>__*` — a SERVER-LEVEL MCP grant.
 *
 * sub-agents.md § *Available tools*: "Both fields accept MCP server-level
 * patterns in addition to exact tool names: `mcp__<server>` or
 * `mcp__<server>__*` grants or removes every tool from the named server. In
 * `disallowedTools`, `mcp__*` also removes every MCP tool from any server."
 *
 * Three things that sentence decides, and one it does not:
 *
 * - BOTH spellings mean the same thing, so both parse here.
 * - `mcp__*` is scoped to `disallowedTools` — "In `disallowedTools`" is a
 *   restriction, not an example — and no doc gives a `tools` allowlist any
 *   whole-pool wildcard. So `mcp__*`, `mcp__*__*` and a bare `*` do NOT parse:
 *   the server group is `[A-Za-z0-9_-]+`, which cannot match `*`. Reading one
 *   as a grant would hand an agent every MCP tool in the session from a single
 *   entry, which is the one thing this module must never do.
 * - The server segment may not itself contain `__`. Pi advertises an external
 *   MCP tool as `mcp__<wireName>__<toolName>`
 *   ({@link tryParsePiDynamicMcpBindingName}) and wire names never contain `__`
 *   (`capabilities/mcp-wire-name.ts` collapses `_` runs), so a concrete
 *   `mcp__git__status` is not silently re-read as a bare grant on a server
 *   called `git__status`.
 *
 * What it does not decide is what happens to a Nessy name that only LOOKS like
 * an MCP server's — see {@link RESERVED_MCP_GRANT_SERVER_SEGMENTS}.
 *
 * Case-folded, matching every other name comparison on this axis
 * ({@link normalizePiRuntimeAgentToolName}, and `resolveExplicitTools`'s
 * case-insensitive pool lookup).
 */
const MCP_SERVER_LEVEL_GRANT_SHAPE = /^mcp__([A-Za-z0-9_-]+?)(?:__\*)?$/

/**
 * Prefixes that carry Nessy's OWN tools in MCP spelling, and are therefore not
 * a "named server" any server-level pattern may reach.
 *
 * `mcp__session__*` is the whole list. Nessy advertises 54 built-in session
 * tools under it for the Pi SDK's benefit (`context-categories.ts`:
 * "advertised in MCP spelling (`mcp__session__*`)"; the `sessionBinding` block
 * in `harness-tool-descriptor.ts`). In CLAUDE those are built-in tools, not MCP
 * tools, so no `mcp__<server>__*` pattern reaches them there — which means an
 * imported definition's author cannot have meant them. Expanding it would turn
 * one entry into `plugin_install`, `script_sandbox`, `spawn_session`,
 * `automation_create` and 50 more, a widening no author wrote and the exact
 * failure mode `SUBAGENT_TOOL_SPELLINGS` is narrow to avoid.
 *
 * DEVIATION, recorded with its reason: on a literal reading of the sentence
 * above, a pool that advertises a server called `session` would have its tools
 * granted. We deny instead, because the prefix is ours and not a server's. Same
 * exclusion `lifecycle-bridge.ts` (`mcpServerFromToolName`) and the deferred-MCP
 * candidate set already make for the same reason.
 *
 * `sources` is deliberately NOT here: that segment is the Codex bridge's mount
 * name and never appears in a Pi pool name (`buildMcpToolName` strips it), while
 * a user's source could legitimately be named `sources`.
 */
const RESERVED_MCP_GRANT_SERVER_SEGMENTS: ReadonlySet<string> = new Set(['session'])

/**
 * The server a `tools`/`disallowedTools` entry names at server level, or
 * `undefined` when the entry is not a server-level pattern at all.
 *
 * Callers must try an EXACT pool match first: `mcp__tool_search` and
 * `mcp__tool_load` are real one-separator pool names that also fit the bare
 * `mcp__<server>` shape, and an advertised name always outranks a pattern —
 * the same precedence `resolveExplicitTools` already gives the parametrized
 * form.
 */
export function parseMcpServerLevelGrant(entry: string): string | undefined {
  const server = MCP_SERVER_LEVEL_GRANT_SHAPE.exec(entry.trim().toLowerCase())?.[1]
  if (!server || server.includes('__')) return undefined
  return RESERVED_MCP_GRANT_SERVER_SEGMENTS.has(server) ? undefined : server
}

/**
 * Does one declared entry cover one concrete tool name at server level?
 *
 * BOTH sides of the Pi boundary need this, which is why it lives here.
 * `resolveExplicitTools` (`pi-agent-server/.../runtime-agent-definitions.ts`)
 * expands a pattern into the concrete tools a child arrives holding; the host
 * re-validates that arrival against the author-declared list, which still holds
 * the PATTERN (`SessionManager.ts`, `runtime-agent-tool-unavailable:<tool>`).
 * Expand on one side only and the child is granted N tools the host then
 * refuses — the exact trade the `Agent(...)` strip rule paid for once already.
 *
 * The trailing `__` is the prefix boundary and the whole point: `mcp__git__`
 * does not prefix `mcp__github__create_issue`, so a grant on one server can
 * never admit a tool from another whose name it happens to begin.
 */
export function mcpServerLevelGrantCovers(entry: string, toolName: string): boolean {
  const server = parseMcpServerLevelGrant(entry)
  return server !== undefined && toolName.trim().toLowerCase().startsWith(`mcp__${server}__`)
}

/**
 * Which `disallowedTools` entry removes this tool, or `null` when none does.
 *
 * The DENY half of the sentence {@link parseMcpServerLevelGrant} already
 * carries, and the half that did not read it. Raw page
 * (`curl -sL https://code.claude.com/docs/en/sub-agents.md`),
 * § *Available tools*: "Both fields accept MCP server-level patterns in
 * addition to exact tool names: `mcp__<server>` or `mcp__<server>__*` grants or
 * removes every tool from the named server. In `disallowedTools`, `mcp__*` also
 * removes every MCP tool from any server."
 *
 * **Both fields.** `disallowedTools` went through `matchesToolPattern`'s glob
 * alone, where a bare `mcp__<server>` compiles to `^mcp__<server>$` and
 * therefore matches NO concrete `mcp__<server>__<tool>` name: the author wrote
 * a denial and every tool of that server stayed callable. A deny that silently
 * fails to deny is the worse direction of the bug `1ff71c5a4` (a shredded entry
 * that stopped denying) and `8cd73fa1c` (the grant side of this same sentence)
 * each already cost once.
 *
 * The glob stays the right reader for every OTHER shape, so it keeps them:
 *
 * - `mcp__*` and `mcp__*__*` already remove every MCP tool from any server —
 *   `*` compiles to `[^/]*`, which spans the `__` separators a tool name is
 *   built from — and {@link parseMcpServerLevelGrant} deliberately refuses to
 *   read either as a named server, so both fall through here unchanged. That
 *   arm of the sentence was never broken; it is pinned by test so a later
 *   narrowing of the helper cannot take it out.
 * - exact names, and parametrized entries such as `Bash(*)`, are not
 *   server-level patterns at all and never reach the helper.
 *
 * Consequence of reading the ONE rule rather than a deny-only variant of it:
 * {@link RESERVED_MCP_GRANT_SERVER_SEGMENTS} applies on this side too, so a
 * bare `mcp__session` is not a server-level denial. That costs nothing real —
 * `session` is Nessy's prefix for BUILT-IN tools, which are not MCP tools in
 * Claude and so cannot be what an imported author meant — and the spellings
 * that do reach them, `mcp__session__*` and `mcp__*`, still deny through the
 * glob.
 *
 * BOTH sides of the Pi boundary call this, which is why it lives here beside
 * the grant rule: `allowedTools` (`pi-agent-server/.../spawner.ts`) filters the
 * child's pool before it is sent, and `SessionManager.ts` re-validates the
 * ARRIVING list against the pinned definition
 * (`runtime-agent-tool-unavailable:<tool>`) because that list is
 * transport-supplied and narrowable by its caller. Teaching one side alone
 * leaves the other reading a rule its counterpart does not know — the exact
 * split `1ff71c5a4`, `8cd73fa1c` and `a878817cd` each had to close.
 *
 * Q10-1 — SPELLING, the same defect one cause over. tools-reference.md opens
 * with "The tool names are the exact strings you use in permission rules,
 * subagent tool lists, and hook matchers", and those strings are `Read`,
 * `Write`, `TaskList`, `Agent`; Pi advertises `read`, `write`,
 * `mcp__session__TaskList`, `subagent`. `globToRegex` compiles `Read` to
 * `^Read$`, which matches no `read`, so an author writing the tool's OWN
 * documented name got a denial that removed nothing — a deny that silently
 * fails to deny, for the third time on this axis.
 *
 * The ALLOW side never had the gap: `resolveExplicitTools` resolves exact, then
 * case-insensitive, then through `PI_RUNTIME_AGENT_TOOL_ALIASES`. The three
 * steps below are that ladder, and they reuse
 * {@link normalizePiRuntimeAgentToolName} — the normalizer
 * `isReadOnlySubagentToolGrant` and the host's arrival check already read —
 * rather than adding a second alias table the two sides could drift apart on.
 *
 * The exact/glob pass runs FIRST and unchanged, so every verdict the old rule
 * reached is byte-identical and only entries that used to match NOTHING can now
 * match. That is also the safe direction for a deny list: the alias step folds
 * `ReadFile`/`NotebookRead` onto `read` exactly as the allow side folds them, so
 * a denial can cover a little more than its author's literal word but never
 * less, and never some unrelated tool — the pinned no-widening control.
 *
 * Pure, and recomputed at every call on both sides (`allowedTools` filters per
 * spawn, the host re-validates per arrival). Nothing here caches a normalized
 * denial set, and nothing here reads the session's permission mode, so a mode
 * change arriving by any door cannot leave a stale verdict behind.
 */
export function matchesSubagentToolDenial(
  toolName: string,
  disallowedTools: readonly string[] | undefined,
  label: string,
): string | null {
  if (!disallowedTools || disallowedTools.length === 0) return null
  const serverLevel = disallowedTools.find(entry => mcpServerLevelGrantCovers(entry, toolName))
  if (serverLevel) return serverLevel
  const exact = matchesToolPattern(toolName, [...disallowedTools], label)
  if (exact) return exact
  const lowerTool = toolName.trim().toLowerCase()
  const normalizedTool = normalizePiRuntimeAgentToolName(toolName)
  return disallowedTools.find(entry => (
    matchesToolPattern(lowerTool, [entry.trim().toLowerCase()], label) !== null
    || normalizePiRuntimeAgentToolName(entry) === normalizedTool
  )) ?? null
}

/**
 * Tools a subagent keeps even when its `tools` list restricts everything else.
 *
 * agent-teams.md: "Team coordination tools such as `SendMessage` and the task
 * management tools are always available to a teammate even when `tools`
 * restricts other tools." R20 adopted that for the four task tools; R27a added
 * `ReportFindings` for the same reason — `BUILTIN_AGENT_DEFINITIONS` gives
 * `reviewer` and `auditor` exactly `['read','grep','find','ls']`, so without it
 * the tool whose only purpose is structured review output is unreachable from
 * the only agents it was written for.
 *
 * Not a permission widening. None of the five can move a subagent's permission
 * MODE (`clampPermissionModeToParent` bounds that by index into
 * `PERMISSION_MODE_ORDER`), all five are "Permission required: No"
 * (tools-reference.md:51-56), the task tools read and write only the
 * session-scoped list the parent already owns, and `ReportFindings` reaches
 * nothing beyond its own tool result. `PushNotification` (reaches the OS) and
 * `SendUserFile` (delivers file content outside the transcript) are
 * deliberately NOT here and must be named.
 *
 * Q10-2 — the list is written in the DOCUMENTED spelling and compared through
 * {@link normalizePiRuntimeAgentToolName}, because those two are not the same
 * string. `TaskCreate` is a handlerName/permissionName; the pool a subagent is
 * built against is `manifest.tools.map(t => t.binding.piName)`, and
 * `sessionBinding('task_create', 'TaskCreate')` makes that piName
 * `mcp__session__TaskCreate`. The original compare (`name === tool ||
 * name.endsWith('__' + tool)`) therefore matched nothing in any real session and
 * the union was inert — visible only in fixtures written with the bindingName
 * spelling. The alias table is the one place that knows the two are one tool, so
 * it is what both sides read rather than a second name table.
 *
 * BOTH sides of the Pi boundary need this, which is why it lives here.
 * `buildPiRuntimeAgentDefinitions` unions these into the child's pool; the host
 * re-validates the ARRIVING list against the pinned definition's DECLARED list
 * (`SessionManager.ts`, `runtime-agent-tool-unavailable:<tool>`), and an
 * always-available tool is by construction absent from that declared list. Union
 * on one side only and every restricted agent trades a silently-inert grant for
 * a spawn-time refusal — the trade P6b, P7 and P8 each paid once already.
 */
export const SUBAGENT_ALWAYS_AVAILABLE_TOOLS: readonly string[] = Object.freeze([
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ReportFindings',
])

const ALWAYS_AVAILABLE_SUBAGENT_TOOL_KEYS: ReadonlySet<string> = new Set(
  SUBAGENT_ALWAYS_AVAILABLE_TOOLS.map(normalizePiRuntimeAgentToolName),
)

/** Is this tool one an author's `tools` list may not remove? Any spelling. */
export function isAlwaysAvailableSubagentTool(tool: string): boolean {
  return ALWAYS_AVAILABLE_SUBAGENT_TOOL_KEYS.has(normalizePiRuntimeAgentToolName(tool))
}

/**
 * The tools a subagent may hold and still share the parent's live checkout.
 *
 * Not a permission list — a WORKTREE list. Everything outside it can change the
 * tree (or reach a seam that can), so an agent holding one gets an isolated
 * repository copy instead. Read by `piRuntimeAgentWorktreePolicy` alone.
 *
 * This set existed THREE times before P8 — twice in `SessionManager.ts` (the
 * child-admission check and the plugin-hook spawn route) and once as
 * `READ_ONLY_TOOLS` in `pi-agent-server/.../runtime-agent-definitions.ts`. They
 * happened to be identical; nothing made them stay that way, and the rule they
 * feed had already drifted on its INPUT, which is the defect P8 fixes.
 *
 * Distinct from `READ_ONLY_TOOLS` in `agents/definitions.ts` — that one is the
 * default tool LIST a `toolset: read-only` builtin is given (four names), not
 * the predicate for whether a list is read-only.
 */
export const READ_ONLY_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  'read', 'grep', 'find', 'ls', 'web_search', 'web_fetch', 'mcp__tool_search', 'get_subagent_result',
])

export type PiRuntimeAgentWorktreePolicy = 'shared' | 'isolated-worktree'

/**
 * Is an author's DECLARED `tools` list read-only?
 *
 * The input is the declared list, never the resolved one, and that is the whole
 * of P8. An entry can fail to resolve (a parametrized non-`Agent` grant, a
 * capability this manifest lacks, a server-level pattern for an absent server)
 * or resolve and then be withheld (`ask_user`; `subagent` at the depth limit),
 * and reading the REMAINDER made a list its author wrote as writing look
 * read-only. The two sides read different lists, so they answered differently
 * and the spawn died on `runtime-agent-worktree-policy-mismatch`.
 *
 * Declared is also the safer of the two inputs, not merely the one that agrees:
 * it is digest-protected (it reaches the host inside the pinned definition),
 * where a child's arriving `tools` is transport-supplied and may be narrowed by
 * its caller — and the host RE-ADDS `memory:`'s Read/Write/Edit grant AFTER the
 * policy check, so "arrived read-only" never did mean "cannot write".
 *
 * A tool-less definition INHERITS the parent's pool, which is not read-only:
 * `undefined` is not a read-only list.
 *
 * An empty list CAN occur since P2.202 — this line read "cannot occur
 * (`parseTools` omits it)" while that was true — and it is read-only by the
 * `.every` above, vacuously: an author who declared no tools declared no
 * writing tool, so the agent shares the live checkout. That is measured, not
 * assumed (`isReadOnlySubagentToolGrant([]) === true` →
 * `piRuntimeAgentWorktreePolicy({ tools: [] }) === 'shared'`), and it is the
 * SAME answer on both sides of the Pi boundary because both reach it through
 * this one function — so admitting the empty set here cannot reopen
 * `runtime-agent-worktree-policy-mismatch`.
 */
export function isReadOnlySubagentToolGrant(tools: readonly string[] | undefined): boolean {
  return tools !== undefined
    && tools.every(tool => READ_ONLY_SUBAGENT_TOOLS.has(normalizePiRuntimeAgentToolName(tool)))
}

/**
 * The ONE worktree-policy rule, read by both sides of the Pi boundary.
 *
 * - the host's child-admission check (`SessionManager.ts`,
 *   `runtime-agent-worktree-policy-mismatch`) — the validator;
 * - the host's plugin-hook agent spawn route (`SessionManager.ts`) — a producer
 *   that must pass that validator, and that used to ignore `isolation`;
 * - the Pi runtime, through `buildPiRuntimeAgentDefinitions`'s `toolset` and the
 *   spawner's `isolation === 'worktree' || toolset === 'full'` — the other
 *   producer.
 *
 * `isolation: worktree` (sub-agents.md § *Choose where a subagent runs*: "To
 * give the subagent an isolated copy of the repository instead, set
 * `isolation: worktree`") is an explicit author request and outranks the
 * toolset-derived default. It only ever narrows.
 *
 * The Pi side reaches this rule through `isReadOnlySubagentToolGrant` plus the
 * spawner's own OR rather than by calling this function, because the spawner
 * also serves BUILTIN definitions, whose `toolset` is authored rather than
 * derived from a declared list. The two expressions are pinned equal by the
 * cross-side table in `runtime-agent-definitions.test.ts`.
 */
export function piRuntimeAgentWorktreePolicy(definition: {
  tools?: readonly string[] | undefined
  isolation?: string | undefined
}): PiRuntimeAgentWorktreePolicy {
  return definition.isolation !== 'worktree' && isReadOnlySubagentToolGrant(definition.tools)
    ? 'shared'
    : 'isolated-worktree'
}

export function normalizePiRuntimeAgentToolName(tool: string): string {
  const trimmed = tool.trim().toLowerCase()
  const base = PARAMETRIZED_TOOL_SHAPE.exec(trimmed)?.[1]
  const normalized = base && SUBAGENT_TOOL_SPELLINGS.has(base) ? base : trimmed
  for (const [externalName, aliases] of Object.entries(PI_RUNTIME_AGENT_TOOL_ALIASES)) {
    if (externalName === normalized || aliases.some(alias => alias.toLowerCase() === normalized)) {
      return aliases[0]!.toLowerCase()
    }
  }
  return normalized
}

/**
 * P6.19 — the ROSTER half of cross-session messaging, for a subagent whose
 * `tools` list named the sending half.
 *
 * `cross-session-messaging.md` (intro): "Claude uses two tools for this:
 * `ListAgents` to discover which agents it can reach, and `SendMessage` to
 * deliver a message to one of them by name." Two tools, one capability. Ours are
 * `list_sessions` and `send_agent_message` — the spelling divergence and its
 * reason are in {@link PI_RUNTIME_AGENT_TOOL_ALIASES}'s `listagents` entry.
 *
 * Measured before this existed: an author who wrote `tools: [Read, SendMessage]`
 * got the sending half and nothing else, so the subagent could only answer a
 * session that had already written to it — the sender id arrives inside the
 * delivery envelope ("Use send_agent_message with sessionId … to reply"). It
 * could not discover a peer, which is the half the page calls discovery. An
 * agent that inherits the parent pool (`tools` absent) already had both, so the
 * gap was exactly the RESTRICTED agent — the one whose author was most explicit.
 *
 * ## Why this is CONDITIONAL and not a sixth always-available tool
 *
 * A roster is a DISCLOSURE, not a convenience, and P0.1 settled that
 * `send_agent_message`'s authority is a thing to scope rather than to spread.
 * Adding `list_sessions` to {@link SUBAGENT_ALWAYS_AVAILABLE_TOOLS} would hand
 * the workspace's session list to every restricted subagent in the product,
 * including ones written to touch nothing outside their own files. The grant is
 * therefore keyed on the author's own declaration: an agent that already holds
 * the tool that WRITES to peers learns nothing new by being able to name them,
 * and an agent that does not hold it gains nothing at all.
 *
 * Three narrowings it does not cross, all pre-existing:
 *
 * - it grants only a tool the PARENT's pool already carries, so a session
 *   without `list_sessions` cannot produce one here;
 * - `list_sessions` is `readOnly` and workspace-scoped by its own handler, so
 *   the disclosure boundary is the handler's, not this grant's;
 * - an explicit `disallowedTools` still wins, by the same route it wins over the
 *   always-available five: the spawner's `allowedTools` filter removes the tool
 *   before it is sent, and the host's arrival check ORs the denial in.
 *
 * ## Read off the DECLARED list on both sides
 *
 * P8's lesson verbatim. The declared list is digest-protected (it reaches the
 * host inside the pinned definition) and is the one input both sides can compute
 * the same answer from; the arriving list is transport-supplied and narrowable by
 * its caller. An ABSENT list is "inherit the parent pool" and needs no grant —
 * that agent already has both tools if the session does.
 */
export const SUBAGENT_MESSAGING_TOOL = 'send_agent_message'

/** The discovery half. `ListAgents` upstream; see {@link SUBAGENT_MESSAGING_TOOL}. */
export const SUBAGENT_ROSTER_TOOL = 'list_sessions'

/** True when `tool` is the roster tool under ANY of its accepted spellings. */
export function isSubagentRosterTool(tool: string): boolean {
  return normalizePiRuntimeAgentToolName(tool) === normalizePiRuntimeAgentToolName(SUBAGENT_ROSTER_TOOL)
}

/** True when an author's DECLARED `tools` list names the messaging tool. */
export function declaresSubagentMessagingTool(tools: readonly string[] | undefined): boolean {
  const key = normalizePiRuntimeAgentToolName(SUBAGENT_MESSAGING_TOOL)
  return (tools ?? []).some(tool => normalizePiRuntimeAgentToolName(tool) === key)
}

/**
 * The roster tools to union into a subagent's pool, given what its author
 * declared and what this session actually has.
 *
 * Empty unless the declared list names the messaging tool AND the pool carries
 * the roster tool, so it can only ever add a name the parent already held.
 * `buildPiRuntimeAgentDefinitions` unions the result into the child's pool; the
 * host's arrival check admits the same names through
 * {@link isSubagentRosterTool}, because a tool granted this way is by
 * construction absent from the declared list that check validates against —
 * the same shape, and the same both-sides requirement, as Q10-2's five.
 */
export function subagentRosterToolGrant(
  declaredTools: readonly string[] | undefined,
  availableToolNames: readonly string[],
): string[] {
  if (!declaresSubagentMessagingTool(declaredTools)) return []
  return availableToolNames.filter(isSubagentRosterTool)
}

/**
 * Path-free Pi transport for an imported agent definition. The host resolves
 * and hash-verifies the immutable capability resource before this object is
 * sent to the Pi subprocess; the subprocess revalidates every bounded field.
 */
export interface PiRuntimeAgentDefinitionDescriptor {
  schemaVersion: 2
  key: string
  name: string
  description: string
  selectedAsUnqualifiedAlias: boolean
  systemPrompt: string
  sha256: string
  provenance: string
  capabilityGeneration: string
  definitionDigest: string
  model?: string
  tools?: readonly string[]
  disallowedTools?: readonly string[]
  tier?: AgentTier
  effort?: ThinkingLevel
  maxTurns?: number
  permissionMode?: PermissionMode
  skillKeys?: readonly string[]
  mcpServerKeys?: readonly string[]
  memory?: AgentMemoryScope
  background?: boolean
  color?: AgentColor
  isolation?: AgentIsolation
  /**
   * sub-agents.md:297 — "Auto-submitted as the first user turn when this agent
   * runs as the main session agent (via `--agent` or the `agent` setting)."
   *
   * Carried so the value survives the host->Pi round trip instead of being
   * dropped at parse time; NOT consumed anywhere yet, because the surface that
   * row names (`--agent`/`--agents`/an `agent` setting) does not exist in this
   * fork — R30c's recorded deviation. It is deliberately not forwarded onto a
   * subagent by `buildPiRuntimeAgentDefinitions`: the row scopes the field to
   * the main session agent.
   *
   * Position matters. `definitionDigest` is `sha256(JSON.stringify(...))`, so
   * every key added here must be appended LAST in both object literals that
   * build a descriptor — `buildPiRuntimeAgentDescriptor`'s `descriptor` and
   * `parseDefinitionEntry`'s `parsed` — or the two sides hash differently and
   * every definition carrying it fails the digest check and vanishes from the
   * session. (`componentHooks` below was appended after this one under that
   * rule.)
   */
  initialPrompt?: string
  /**
   * R87b — the definition's frontmatter `hooks` block (`sub-agents.md` § *Hooks
   * in subagent frontmatter*), already partitioned into the tier the child
   * session dispatches and the tier the parent dispatches on `SubagentStop`.
   *
   * Pinned HERE, on the digest-protected descriptor, for the same reason
   * `memory` and `skillKeys` are: it is an AUTHOR declaration that decides
   * which commands run, never a call-site one. The host copies it onto the
   * child's restrictions itself and refuses any transport-supplied value.
   *
   * Absent for a PLUGIN subagent (`sub-agents.md`: "plugin subagents don't
   * support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields")
   * and for a project-scoped definition whose folder is not trusted — in the
   * second case the definition still loads and only its hooks are dropped,
   * which is the documented failure mode.
   *
   * Appended LAST, under the ordering rule above.
   */
  componentHooks?: SubagentComponentHooks
  /**
   * P6.790 / P6.808 — the INLINE half of the definition's `mcpServers` list,
   * keyed by server name, beside {@link mcpServerKeys}, which stays the
   * NAME-REFERENCE half.
   *
   * `sub-agents.md#scope-mcp-servers-to-a-subagent`: *"Each entry in the list is
   * either an inline server definition or a string referencing an MCP server
   * already configured in your session"*, and *"Inline definitions use the same
   * schema as `.mcp.json` server entries, keyed by the server name"*. Two fields
   * rather than one union for the reason `AgentDefinition.mcpServerInline`
   * states: a reference resolves against the session's own capability view and
   * loads with no trust check, while an inline definition is a server this file
   * is asking to START and loads only after its folder is trusted (P6.792).
   *
   * CARRIED, NOT STARTED. Nothing spawns a server from this field yet; it is
   * here so the value survives the host->Pi round trip instead of being the
   * reason the whole definition is refused — which is what it was until P6.808
   * (measured at HEAD: the page's own example returned
   * `Invalid agent.<name>.mcpServers[0]: expected non-empty string`, and the
   * agent was excluded from the session entirely).
   *
   * Absent for a PLUGIN subagent, with `mcpServerKeys` and for the same
   * documented reason, and absent whenever the resolved view supplied
   * `mcpServerKeys` itself — the view carries no inline map, and the frontmatter
   * is not consulted when the view has already answered.
   *
   * Appended LAST, under the ordering rule above.
   */
  mcpServerInline?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /**
   * P6.816 / P6.792 — the folder-trust VERDICT for {@link mcpServerInline},
   * stated rather than re-derived.
   *
   * `sub-agents.md`, the explicit `<span id="inline-server-trust" />` anchor:
   * *"Claude Code loads an inline server from an agent file in your project's
   * `.claude/agents/` directory, or in an `--add-dir` directory's
   * `.claude/agents/`, only after you trust the folder the agent file came
   * from."* The same section lists what loads WITHOUT that check — a name
   * reference, and an inline server from `~/.claude/agents/`, from `--agents`
   * or the SDK `agents` option, or from managed settings — which is exactly the
   * set {@link subagentHookScope} folds into its `'user'` scope.
   *
   * Present if and only if `mcpServerInline` is, and `parseDefinitionEntry`
   * refuses either one without the other BY NAME. That is the whole point:
   * without it the subprocess accepts an inline map on its own authority and
   * the question "was trust consulted?" has no answer on the wire — an
   * invariant maintained by one builder rather than a checked contract. With
   * it, a NEW producer of `mcpServerInline` cannot ship without deciding trust;
   * it fails loudly at parse, naming the field.
   *
   * The digest is not a substitute. It proves the descriptor was not tampered
   * with in transit; it says nothing about whether the host asked the trust
   * question before building it.
   *
   * Appended LAST, under the ordering rule above.
   */
  mcpServerInlineTrusted?: true
  /**
   * F1.1203 — the name Claude Code itself loads a trusted project's
   * `.claude/agents` copy under ({@link isClaudeProjectAgentCopyKey}): the
   * frontmatter `name`, not the file name. `sub-agents.md`: identity "comes
   * only from the `name` frontmatter field" and "The filename doesn't have to
   * match"; a file with no `name` is documentation and one with "A `name` but
   * no `description`" is skipped, so neither carries it. Read only by
   * `buildClaudeRuntimeAgents`, which drops the bundled agent this name takes
   * over. Appended LAST, under the ordering rule above.
   */
  claudeAgentName?: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}: expected string`)
  const normalized = value.trim()
  if (!options.allowEmpty && !normalized) throw new Error(`Invalid ${label}: expected non-empty string`)
  if (normalized.length > maxLength) throw new Error(`Invalid ${label}: exceeds ${maxLength} characters`)
  return normalized
}

/**
 * Did the author WRITE this list key and hand it nothing?
 *
 * P2.185's rule at the wire layer, and the twin of `isAuthoredEmptyList` in
 * `agents/definitions.ts` — the two agent parsers held opposite answers to this
 * one question until P2.202, which is what made the divergence below untestable.
 *
 * Only the ARRAY spelling is tested here, unlike the frontmatter twin which also
 * reads `''`. This parser's input is already-decoded JSON off the wire, and its
 * producer (`buildPiRuntimeAgentDescriptor` → `optionalToolList`) has already
 * folded every authored-empty spelling — `tools:`, `tools: []`, `tools: ""`,
 * `tools: ,,,` — onto `[]`. A `''` cannot reach this function, and a branch that
 * cannot fire is a branch nothing pins.
 */
function isAuthoredEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
}

/**
 * Which entries did the author NAME? `undefined` for both an omitted key and an
 * empty one — this function cannot tell them apart, and does not try.
 * {@link isAuthoredEmptyList} is the distinction, and each caller applies it to
 * its OWN field, exactly as `agents/definitions.ts` does:
 *
 * - `tools` is the field where the two answers DIFFER, and its call site says so;
 * - `disallowedTools`, `skillKeys` and `mcpServerKeys` read this return value
 *   alone, because for them the empty set and the absent key really do coincide
 *   — an empty denylist denies nothing, an empty preload list preloads nothing.
 *
 * A present list with a malformed ENTRY still throws, and the caller skips that
 * one definition rather than the session: the throw this replaced
 * (`Unavailable runtime agent tool(s): …`) was unscoped, and one `tools: []`
 * file made every send in every session die at materialize time.
 */
function parseTools(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_AGENT_TOOLS) {
    throw new Error(`Invalid ${label}: expected at most ${MAX_AGENT_TOOLS} tools`)
  }
  if (value.length === 0) return undefined
  const tools = value.map((tool, index) => boundedString(
    tool,
    `${label}[${index}]`,
    MAX_AGENT_TOOL_LENGTH,
  ))
  return Object.freeze([...new Set(tools)])
}

/**
 * The `tools` field's own reading of an authored-empty list: the empty SET.
 *
 * P2.202, decided against the page rather than against our own inference. What
 * stood here — "an empty list has no entries and restricts nothing, so it parses
 * exactly as the omitted field does — inherit" — is refuted by
 * `errors.md#agent-would-be-spawned-with-zero-tools`, re-fetched 2026-08-27:
 * "Omitting the `tools` field never triggers this refusal. If you leave the
 * `tools` list empty, or `disallowedTools` removes every entry in it, Claude
 * Code also skips the refusal and launches the subagent without tools." And the
 * same section's fix list states the author's half: "Delete the `tools` field
 * instead of listing tools to give the subagent every tool available to
 * subagents." Deleted means everything; empty means nothing.
 *
 * So the inherit-everything default belongs to the OMITTED key alone. Reading it
 * off `[]` as well handed an author who declared no tools the whole session pool
 * — the widening `53007d740`'s invariant exists to forbid: truncation must never
 * widen. `agents/definitions.ts` reached this conclusion for the same field on
 * 2026-08-26 (`6e9e7d2b1`) and `claude-runtime-agents.ts` reached it for the
 * skill-emptied case before that; this is the third of the three agreeing.
 *
 * The empty set is NOT a refusal here or anywhere downstream — see
 * `canonicalizeRuntimeSkillToolGrants`, whose admission throw was removed in the same pass
 * for the same sentence.
 */
function parseDeclaredTools(value: unknown, label: string): readonly string[] | undefined {
  return parseTools(value, label)
    ?? (isAuthoredEmptyList(value) ? EMPTY_TOOL_LIST : undefined)
}

const EMPTY_TOOL_LIST: readonly string[] = Object.freeze([])

/**
 * `tools` / `disallowedTools` — a TOOL-GRANT list, and therefore NOT a job for
 * {@link optionalStringList}'s bare comma split.
 *
 * `splitToolGrantList` is the one tokenizer, shared with the skill path
 * (`parseSkillToolList`) and the Claude plugin adapter, so the three cannot
 * drift; its own doc carries the two rules and their citations. The comma split
 * this replaced turned the documented `Agent(scan-inventory, scan-researcher)`
 * into `Agent(scan-inventory` plus `scan-researcher)` — two names no runtime
 * resolves, so the Pi side denied both by omission and the grant vanished. On
 * `disallowedTools` the same shredding lost a DENIAL, which is the worse
 * direction of the same bug.
 *
 * `skills` and `mcpServers` deliberately stay on {@link optionalStringList}:
 * they name capability references, not tool grants, so a parenthesis has no
 * meaning there and whitespace is not a documented delimiter for them.
 *
 * A REAL JSON array still goes to the sibling, so its per-entry validation
 * survives: `tools: ["Read", 1]` must keep refusing the agent (A1 — the refusal
 * costs that one definition, never the session). That shape only reaches this
 * reader through `splitMarkdownFrontmatter`'s fallback scanner, which keeps a
 * line verbatim for a document js-yaml rejects; the js-yaml path flattens the
 * same line to `Read, 1` and the refusal is already unreachable there.
 *
 * A bracketed value that is NOT JSON (`tools: [Read, Grep]`, a YAML flow
 * sequence) falls through to the tokenizer instead of failing a JSON parse and
 * taking the agent with it — the skill path has always read that shape.
 */
function optionalToolList(value: string | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && isJsonArrayText(trimmed)) return optionalStringList(trimmed, label)
  return [...new Set(splitToolGrantList(trimmed))]
}

function isJsonArrayText(value: string): boolean {
  try {
    return Array.isArray(JSON.parse(value))
  } catch {
    return false
  }
}

function optionalStringList(value: string | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (!Array.isArray(parsed)) throw new Error('expected array')
      return parsed.map((entry, index) => {
        if (typeof entry !== 'string' || !entry.trim()) {
          throw new Error(`Invalid ${label}[${index}]: expected non-empty string`)
        }
        return entry.trim()
      })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`Invalid ${label}`)) throw error
      throw new Error(`Invalid ${label}: expected a JSON string array`)
    }
  }
  return trimmed.split(',').map((entry, index) => {
    const normalized = entry.trim()
    if (!normalized) throw new Error(`Invalid ${label}[${index}]: expected non-empty string`)
    return normalized
  })
}

/**
 * P6.808 — `mcpServers` on the host->Pi path: the one list key whose entries are
 * TWO different things, split into the two fields that carry them.
 *
 * This is the SECOND parse site for that shape. The first, in
 * `agents/definitions.ts`, was fixed by P6.790; this one reads the flat
 * frontmatter map instead and was therefore untouched by it. Measured at HEAD on
 * the page's own example (an inline `playwright` entry followed by a `- github`
 * reference), `optionalStringList` threw
 * `Invalid agent.<name>.mcpServers[0]: expected non-empty string` and
 * {@link materializePiRuntimeAgentDefinitions} EXCLUDED the whole definition —
 * the reference form the parity row records as working was lost by the mere
 * presence of an inline sibling, the same silent-drop shape P6.790 named, one
 * layer down.
 *
 * It needs no raw-YAML re-read, and that is worth stating because the file
 * records the opposite for `hooks` at {@link withPluginExclusions}:
 * `splitMarkdownFrontmatter` keeps a nested MAPPING opaque (`hooks:` flattens to
 * `''`), but a SEQUENCE carrying a mapping keeps its full JSON form —
 * `[{"playwright":{"type":"stdio","command":"npx"}},"github"]` — because
 * `flattenFrontmatterValue` emits JSON for any list that is not all-strings.
 * The structure is already here; only this reader was throwing it away.
 *
 * A list with NO inline entry goes through {@link optionalStringList}
 * unchanged, so every message and every empty-list semantic that reader owns is
 * untouched: this widens what parses, it does not reinterpret a shape that was
 * already reaching a caller. A malformed inline entry is still refused BY NAME,
 * with the same wording the `agents/definitions.ts` reader uses — the two are
 * deliberately not shared, because that module imports this one and the reverse
 * edge would be a cycle.
 */
function optionalMcpServerList(value: string | undefined, label: string): {
  keys: string[] | undefined
  inline: Record<string, Record<string, unknown>> | undefined
} {
  if (value === undefined) return { keys: undefined, inline: undefined }
  const trimmed = value.trim()
  let entries: unknown[] | undefined
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) entries = parsed
    } catch {
      // Not JSON after all — the sibling reader owns that refusal.
    }
  }
  if (!entries?.some(entry => entry !== null && typeof entry === 'object')) {
    return { keys: optionalStringList(value, label), inline: undefined }
  }
  const keys: string[] = []
  const inline: Record<string, Record<string, unknown>> = {}
  entries.forEach((entry, index) => {
    if (typeof entry === 'string') {
      if (!entry.trim()) throw new Error(`Invalid ${label}[${index}]: expected non-empty string`)
      keys.push(entry.trim())
      return
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid ${label}[${index}]: expected a server name or an inline server definition`)
    }
    // "Inline definitions use the same schema as `.mcp.json` server entries,
    // keyed by the server name" — so every own key of the entry names a server.
    // An entry naming none is refused rather than ignored: it is an author
    // asking for a server and getting none.
    const names = Object.keys(entry as Record<string, unknown>)
    if (names.length === 0) {
      throw new Error(`Invalid ${label}[${index}]: inline server definition names no server`)
    }
    for (const name of names) {
      const config = (entry as Record<string, unknown>)[name]
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`Invalid ${label}[${index}].${name}: expected an inline server definition`)
      }
      inline[name] = config as Record<string, unknown>
    }
  })
  return {
    keys: keys.length > 0 ? [...new Set(keys)] : undefined,
    inline: Object.keys(inline).length > 0 ? inline : undefined,
  }
}

/**
 * The wire half of {@link optionalMcpServerList}: structurally accept an
 * already-parsed inline map WITHOUT rebuilding it, exactly as
 * `staticSubagentComponentHooks` does for `componentHooks` and for the same
 * reason — the digest is `sha256(JSON.stringify(...))`, so rebuilding the record
 * would re-order its keys and every definition carrying it would fail the digest
 * check and vanish from the session. Only a shape that could crash a consumer is
 * rejected.
 */
function staticMcpServerInline(value: unknown, label: string): Record<string, Record<string, unknown>> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`Invalid ${label}`)
  const names = Object.keys(value)
  if (names.length === 0) throw new Error(`Invalid ${label}`)
  for (const name of names) {
    const config = value[name]
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`Invalid ${label}.${name}`)
    }
  }
  return value as Record<string, Record<string, unknown>>
}

function resolveReferences(
  requested: readonly string[] | undefined,
  available: readonly { key: string; logicalName: string; selectedAsUnqualifiedAlias?: boolean }[],
  label: string,
): string[] | undefined {
  // Empty means omitted, same decision as `parseTools`: a list that references
  // nothing requests nothing.
  if (requested === undefined || requested.length === 0) return undefined
  return requested.map(reference => {
    const match = available.find(value => value.key === reference)
      ?? available.find(value => value.selectedAsUnqualifiedAlias && value.logicalName === reference)
    if (!match) throw new Error(`Unavailable ${label} reference: ${reference}`)
    return match.key
  })
}

/**
 * The candidate table {@link resolveReferences} matches an `mcpServers` name
 * reference against — extracted so the FILE route and the `--agents` session
 * route resolve a name identically. Two copies of this expression would drift in
 * the direction review finding 1 (2026-08-10) already found once: a plugin
 * server shadowing a user-created source that owns the same bare name.
 *
 * The rows, and why each is here:
 *  - every `view.mcpServers` entry by KEY, aliased by its wire name;
 *  - a bare-name alias for a PLUGIN server, only when unambiguous (T3) —
 *    ambiguity is counted across BOTH tables, because a user-created MCP source
 *    lives in `view.sources` and would otherwise be invisible to the count while
 *    still owning the name;
 *  - every source that publishes an MCP wire name.
 */
function mcpReferenceCandidates(
  view: Pick<AgentRuntimeView, 'mcpServers' | 'sources'>,
): { key: string; logicalName: string; selectedAsUnqualifiedAlias?: boolean }[] {
  return [
    ...view.mcpServers.map(server => ({ key: server.key, logicalName: server.wireName, selectedAsUnqualifiedAlias: true })),
    ...view.mcpServers.flatMap(server => {
      if (!server.pluginInstanceId) return []
      const mcpContenders = view.mcpServers.filter(other => other.logicalName === server.logicalName).length
      const sourceContenders = view.sources.filter(source => source.mcpWireName && source.logicalName === server.logicalName).length
      return mcpContenders + sourceContenders === 1
        ? [{ key: server.key, logicalName: server.logicalName, selectedAsUnqualifiedAlias: true }]
        : []
    }),
    ...view.sources.flatMap(source => source.mcpWireName
      ? [{ key: source.key, logicalName: source.logicalName, selectedAsUnqualifiedAlias: true }]
      : []),
  ]
}

function definitionDigest(definition: Omit<PiRuntimeAgentDefinitionDescriptor, 'definitionDigest'>): string {
  return sha256(JSON.stringify(definition))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One excluded entry, for the caller's diagnostics channel. */
export interface PiRuntimeAgentEntryFailure {
  index: number
  key?: string
  name?: string
  reason: string
}

/**
 * Wire-level parse of the agent-definitions list, PER ENTRY: a valid entry
 * loads, an invalid one is EXCLUDED and reported through `onInvalid` — it
 * never fails the list. Claude's contract (sub-agents.md) treats a malformed
 * subagent definition as that agent's problem, not the session's, and this
 * parser used to throw on the first bad entry, which made one bad file in
 * `~/.nessy-agent/agents/` kill every send in every session.
 *
 * List-level malformation (not an array, over the agent ceiling) still throws:
 * that is a producer bug, not one bad definition, and must stay loud.
 * Exclusion is fail-closed — a tampered or unparseable entry never loads.
 */
export function parsePiRuntimeAgentDefinitions(
  value: unknown,
  options: { onInvalid?: (failure: PiRuntimeAgentEntryFailure) => void } = {},
): readonly PiRuntimeAgentDefinitionDescriptor[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_AGENTS) {
    throw new Error(`Invalid piRuntimeAgentDefinitions: expected at most ${MAX_RUNTIME_AGENTS} agents`)
  }

  const seenKeys = new Set<string>()
  const definitions: PiRuntimeAgentDefinitionDescriptor[] = []
  for (const [index, raw] of value.entries()) {
    try {
      definitions.push(parseDefinitionEntry(raw, index, seenKeys))
    } catch (error) {
      const record = isRecord(raw) ? raw : undefined
      options.onInvalid?.({
        index,
        ...(typeof record?.key === 'string' ? { key: record.key } : {}),
        ...(typeof record?.name === 'string' ? { name: record.name } : {}),
        reason: reasonOf(error),
      })
    }
  }
  return Object.freeze(definitions)
}

function parseDefinitionEntry(
  raw: unknown,
  index: number,
  seenKeys: Set<string>,
): PiRuntimeAgentDefinitionDescriptor {
  {
    const label = `piRuntimeAgentDefinitions[${index}]`
    if (!isRecord(raw) || raw.schemaVersion !== 2) {
      throw new Error(`Invalid ${label}: schemaVersion 2 is required`)
    }
    const key = boundedString(raw.key, `${label}.key`, MAX_AGENT_KEY_LENGTH)
    if (seenKeys.has(key)) throw new Error(`Invalid ${label}: duplicate key`)
    seenKeys.add(key)
    const name = boundedString(raw.name, `${label}.name`, MAX_AGENT_NAME_LENGTH)
    const description = boundedString(
      raw.description,
      `${label}.description`,
      MAX_AGENT_DESCRIPTION_LENGTH,
      { allowEmpty: true },
    )
    const systemPrompt = boundedString(raw.systemPrompt, `${label}.systemPrompt`, MAX_AGENT_PROMPT_BYTES)
    if (Buffer.byteLength(systemPrompt, 'utf8') > MAX_AGENT_PROMPT_BYTES) {
      throw new Error(`Invalid ${label}.systemPrompt: exceeds ${MAX_AGENT_PROMPT_BYTES} bytes`)
    }
    const contentHash = boundedString(raw.sha256, `${label}.sha256`, 64)
    if (!/^[a-f0-9]{64}$/.test(contentHash) || sha256(systemPrompt) !== contentHash) {
      throw new Error(`Invalid ${label}.sha256`)
    }
    const provenance = boundedString(raw.provenance, `${label}.provenance`, MAX_AGENT_KEY_LENGTH)
    const capabilityGeneration = boundedString(raw.capabilityGeneration, `${label}.capabilityGeneration`, MAX_AGENT_KEY_LENGTH)
    if (typeof raw.selectedAsUnqualifiedAlias !== 'boolean') {
      throw new Error(`Invalid ${label}.selectedAsUnqualifiedAlias`)
    }
    const tools = parseDeclaredTools(raw.tools, `${label}.tools`)
    const disallowedTools = parseTools(raw.disallowedTools, `${label}.disallowedTools`)
    const model = raw.model === undefined
      ? undefined
      : boundedString(raw.model, `${label}.model`, MAX_AGENT_NAME_LENGTH)
    const tier = raw.tier === undefined ? undefined : boundedString(raw.tier, `${label}.tier`, 16) as AgentTier
    if (tier && !['small', 'medium', 'big'].includes(tier)) throw new Error(`Invalid ${label}.tier`)
    const effort = raw.effort === undefined ? undefined : normalizeThinkingLevel(raw.effort)
    if (raw.effort !== undefined && !effort) throw new Error(`Invalid ${label}.effort`)
    const maxTurns = raw.maxTurns === undefined ? undefined : raw.maxTurns
    if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || (maxTurns as number) < 1)) throw new Error(`Invalid ${label}.maxTurns`)
    const permissionMode = raw.permissionMode === undefined || typeof raw.permissionMode !== 'string'
      ? undefined
      : parsePermissionMode(raw.permissionMode) ?? undefined
    if (raw.permissionMode !== undefined && !permissionMode) throw new Error(`Invalid ${label}.permissionMode`)
    const skillKeys = parseTools(raw.skillKeys, `${label}.skillKeys`)
    const mcpServerKeys = parseTools(raw.mcpServerKeys, `${label}.mcpServerKeys`)
    const memory = raw.memory === undefined
      ? undefined
      : AGENT_MEMORY_SCOPE_VALUES.find(scope => scope === raw.memory)
    if (raw.memory !== undefined && !memory) throw new Error(`Invalid ${label}.memory`)
    if (raw.background !== undefined && typeof raw.background !== 'boolean') {
      throw new Error(`Invalid ${label}.background`)
    }
    const background = raw.background as boolean | undefined
    const color = raw.color === undefined
      ? undefined
      : AGENT_COLORS.find(value => value === raw.color)
    if (raw.color !== undefined && !color) throw new Error(`Invalid ${label}.color`)
    const isolation = raw.isolation === undefined
      ? undefined
      : raw.isolation === 'worktree' ? 'worktree' as const : undefined
    if (raw.isolation !== undefined && !isolation) throw new Error(`Invalid ${label}.isolation`)
    const initialPrompt = raw.initialPrompt === undefined
      ? undefined
      : boundedString(raw.initialPrompt, `${label}.initialPrompt`, MAX_AGENT_INITIAL_PROMPT_LENGTH)
    // R87b — structurally accepted, never re-parsed: the digest below is the
    // integrity check, and rebuilding the block would change the JSON it is
    // computed over. The producer is `buildPiRuntimeAgentDescriptor`, which has
    // already applied the plugin exclusion and the folder-trust gate.
    const componentHooks = staticSubagentComponentHooks(raw.componentHooks)
    // P6.790 — same contract as `componentHooks` above: structurally accepted,
    // never rebuilt, because the digest below is computed over this exact JSON.
    const mcpServerInline = staticMcpServerInline(raw.mcpServerInline, `${label}.mcpServerInline`)
    // P6.816 — the trust VERDICT is read, never re-derived. The subprocess has
    // no view of which folder the agent file came from and no trust state to
    // consult, so an inline map arriving without the host's verdict is refused
    // rather than started on the parser's own authority; and a verdict with no
    // map is refused too, because it is a statement about nothing.
    if (raw.mcpServerInlineTrusted !== undefined && raw.mcpServerInlineTrusted !== true) {
      throw new Error(`Invalid ${label}.mcpServerInlineTrusted`)
    }
    if (mcpServerInline && raw.mcpServerInlineTrusted !== true) {
      throw new Error(`Invalid ${label}.mcpServerInline: no folder-trust verdict travelled with it`)
    }
    if (!mcpServerInline && raw.mcpServerInlineTrusted === true) {
      throw new Error(`Invalid ${label}.mcpServerInlineTrusted: no inline server travelled with it`)
    }
    const claudeAgentName = raw.claudeAgentName === undefined
      ? undefined
      : boundedString(raw.claudeAgentName, `${label}.claudeAgentName`, MAX_AGENT_NAME_LENGTH)
    const parsed = {
      schemaVersion: 2 as const,
      key,
      name,
      description,
      selectedAsUnqualifiedAlias: raw.selectedAsUnqualifiedAlias,
      systemPrompt,
      sha256: contentHash,
      provenance,
      capabilityGeneration,
      ...(model ? { model } : {}),
      // `tools` is truthiness-tested, NOT length-tested, and the difference is
      // the whole of P2.202: an authored-empty `[]` must survive into the
      // digested shape, where an omitted key must stay absent. Tightening this
      // to `tools.length > 0` re-collapses the two and silently restores the
      // inherit-everything widening. `disallowedTools` below is already
      // `undefined` for both spellings (`parseTools`), so it needs no such care.
      ...(tools ? { tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
      ...(tier ? { tier } : {}),
      ...(effort ? { effort } : {}),
      ...(maxTurns === undefined ? {} : { maxTurns: maxTurns as number }),
      ...(permissionMode ? { permissionMode } : {}),
      ...(skillKeys ? { skillKeys } : {}),
      ...(mcpServerKeys ? { mcpServerKeys } : {}),
      ...(memory ? { memory } : {}),
      ...(background === undefined ? {} : { background }),
      ...(color ? { color } : {}),
      ...(isolation ? { isolation } : {}),
      // The last five keys, in lockstep with `buildPiRuntimeAgentDescriptor` —
      // see the ordering note on the descriptor interface.
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(componentHooks ? { componentHooks } : {}),
      ...(mcpServerInline ? { mcpServerInline } : {}),
      ...(mcpServerInline ? { mcpServerInlineTrusted: true as const } : {}),
      ...(claudeAgentName ? { claudeAgentName } : {}),
    }
    const digest = boundedString(raw.definitionDigest, `${label}.definitionDigest`, 64)
    if (!/^[a-f0-9]{64}$/.test(digest) || definitionDigest(parsed) !== digest) {
      throw new Error(`Invalid ${label}.definitionDigest`)
    }
    return Object.freeze({ ...parsed, definitionDigest: digest })
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * sub-agents.md, "Choose the subagent scope": "For security reasons, plugin
 * subagents don't support the `hooks`, `mcpServers`, or `permissionMode`
 * frontmatter fields. These fields are ignored when loading agents from a
 * plugin."
 *
 * The rule is a scoping rule with a security character: a plugin must not be
 * able to hand its own subagent a broader permission mode, its own MCP servers,
 * or its own lifecycle hooks. Both spellings of each key are listed because the
 * readers below accept either.
 *
 * `initialPrompt` is deliberately NOT in this list. The documented set is closed
 * at those three, and the field is inert here: it is carried but never
 * submitted, because no main-session-agent surface exists. REVISIT THIS WHEN
 * ONE DOES — a plugin-supplied agent that runs as the main session and
 * auto-submits its own first turn is a trust decision this list has not yet
 * been asked to make.
 */
const PLUGIN_IGNORED_AGENT_FRONTMATTER: readonly string[] = Object.freeze([
  'permissionMode', 'permission-mode',
  'mcpServers', 'mcp-servers',
  'hooks',
])

/**
 * A plugin subagent is one whose instructions live inside a plugin bundle;
 * `pluginInstanceId` is present only on `PluginBundleResourceRef`.
 */
function isPluginSubagent(agent: AgentRuntimeView['agents'][number]): boolean {
  return 'pluginInstanceId' in agent.instructionsResource
}

/**
 * R87b — which trust rule a definition's frontmatter hooks fall under.
 * `sub-agents.md` splits by SCOPE, and it is NOT the skill rule R87 reused:
 *
 * - `'plugin'` — "plugin subagents don't support the `hooks`, `mcpServers`, or
 *   `permissionMode` frontmatter fields. These fields are ignored when loading
 *   agents from a plugin." Not a gate that a grant can open; the field is
 *   dropped outright.
 * - `'project'` — "To let a project-level subagent's frontmatter hooks run,
 *   accept the workspace trust dialog for the folder that contains the agent
 *   file." And the failure mode, which is why the gate belongs on the HOOKS and
 *   not on the agent: "Until you trust the folder, the subagent still runs, but
 *   Claude Code skips its frontmatter hooks and logs an error to the debug log."
 * - `'user'` — global (`~/.nessy-agent/agents/`, our `~/.claude/agents/`) and
 *   workspace definitions: "Hooks from user-level subagents in
 *   `~/.claude/agents/` … run without this step."
 */
export type SubagentHookScope = 'plugin' | 'project' | 'user'

/**
 * The `CapabilityScopeKind`s whose agent files are NOT behind the workspace
 * trust dialog: `global` is our `~/.claude/agents/` ("run without this step"),
 * `workspace` is the app's own workspace directory, and `builtin` ships with
 * the app. Every other kind — `project`, and anything a future scope adds — is
 * gated.
 */
const UNGATED_AGENT_HOOK_SCOPES: ReadonlySet<string> = new Set(['builtin', 'global', 'workspace'])

/**
 * The same scope question, under the name the inline-server rule asks it by.
 *
 * `sub-agents.md` states two folder-trust rules over the SAME three scopes —
 * § *Hooks in subagent frontmatter* and the `<span id="inline-server-trust" />`
 * anchor — and both name the identical exempt set: the user-level directory,
 * `--agents`/the SDK `agents` option, and managed settings. One implementation,
 * two readers, so the two rules cannot drift apart. An alias rather than a
 * rename because {@link subagentHookScope} is exported and read by files this
 * lane does not hold.
 */
const mcpServerInlineScope = (agent: AgentRuntimeView['agents'][number]): SubagentHookScope =>
  subagentHookScope(agent)

export function subagentHookScope(agent: AgentRuntimeView['agents'][number]): SubagentHookScope {
  const resource = agent.instructionsResource
  if ('pluginInstanceId' in resource) return 'plugin'
  // Written as an ALLOWLIST of the ungated scopes, not as a `=== 'project'`
  // test. A `NativeResourceRef` always carries a scope in production, so the
  // fallback only ever fires for a hand-built view (fixtures, the session-free
  // validation path) — but this is the one rule in R87b with a security
  // consequence, and "we could not tell" must resolve to the gated scope, not
  // to the one that runs the commands.
  return UNGATED_AGENT_HOOK_SCOPES.has(resource.scope?.kind as string) ? 'user' : 'project'
}

/**
 * Enforced by DELETING the three keys before any field is read, rather than by
 * skipping three reads. An exclusion expressed as "this reader happens not to
 * run" silently becomes a hole the first time a reader is added or moved.
 *
 * **`hooks` is now the exception this warned about, and it is deliberate.**
 * R87b gave the key a reader, and that reader does NOT go through the flat
 * frontmatter map at all — it re-reads the raw YAML, because
 * `splitMarkdownFrontmatter` keeps a nested mapping opaque. Deleting the key
 * from `scoped` therefore protects nothing for it. The plugin exclusion for
 * `hooks` lives in {@link subagentHookScope}'s `'plugin'` arm instead, which the
 * reader consults BEFORE parsing; the key stays listed here so the flat map
 * never carries it either, and so the documented set stays complete in one
 * place.
 *
 * Deleting an IGNORED key also has to happen before validation, not after: an
 * ignored field must not be able to reject the agent for being malformed.
 */
function withPluginExclusions(
  frontmatter: Record<string, string>,
  agent: AgentRuntimeView['agents'][number],
): Record<string, string> {
  if (!isPluginSubagent(agent)) return frontmatter
  const scoped = { ...frontmatter }
  for (const key of PLUGIN_IGNORED_AGENT_FRONTMATTER) delete scoped[key]
  return scoped
}

/**
 * One excluded agent definition, shaped for the doctor/capability-diagnostics
 * channel: it names the file a user would open and the reason it refused to
 * load. Never partial — the whole definition is excluded, so a skipped entry
 * can only ever narrow what the session can do.
 */
export interface PiRuntimeAgentDefinitionDiagnostic {
  /** Capability key of the excluded definition. */
  agentKey: string
  agentName: string
  /**
   * The definition file as the user would find it: the absolute path for a
   * native agent, `<pluginInstanceId>/<relativePath>` for a plugin-bundled one.
   */
  file: string
  reason: string
}

/**
 * P6.315 — the token ceiling the SDK's own startup notice uses for the sum of
 * subagent descriptions, and the semantics recovered from the binary that
 * enforces it rather than invented here.
 *
 * The vendored native binary carries the notice id `large-agent-descriptions`
 * with, verbatim in structure: a reducer over `activeAgents` filtered to
 * `source !== "built-in"`, summing an estimate of `` `${agentType}: ${whenToUse}` ``
 * per agent, against a literal `15000`, tier `warning`.
 * `errors.md#agent-descriptions-are-over-the-15000-token-limit` agrees:
 * "The combined descriptions of your subagents, except the built-in ones,
 * exceed 15,000 tokens as Claude Code estimates them. Each agent counts its name
 * plus its `description` frontmatter. Claude Code loads every agent whether or
 * not the total is over the limit, so the warning doesn't change what loads."
 *
 * That last sentence is a CONTRACT, not a remark: this is a report, never a
 * gate. Nothing below drops, truncates or reorders a definition.
 *
 * ## Why the host computes it even though the runtime has one
 *
 * Native-first, asked and answered: the SDK's notice is real and complete, and
 * it belongs to the CLI's Ink startup-notice list — a TUI surface. We embed the
 * SDK, not the TUI, so it can never reach a Nessy session on any runtime. Pi and
 * codex have no counterpart at all. So this is step 2 — the host supplies it
 * once for all three — and this function is the one seam where it is computable:
 * every runtime's definitions come through
 * {@link materializePiRuntimeAgentDefinitions}.
 *
 * **P6.602 corrects the second half of this paragraph.** It used to read that
 * the capability resolver CANNOT do it, "because a native `.claude/agents/*.md`
 * agent carries `description: ''` there (the resolver hashes the file and reads
 * nothing out of it)". That is no longer true: `native-sources.ts` pins the
 * frontmatter `description` onto the record and the resolver carries it. The
 * conclusion still stands for a different reason — the sum is over the
 * definitions a RUNTIME will actually receive, which is what this seam holds and
 * a capability snapshot does not.
 */
export const AGENT_DESCRIPTION_TOKEN_BUDGET = 15_000

export interface PiRuntimeAgentDescriptionBudgetDiagnostic {
  /** The sum over non-built-in definitions, in the same estimate the offenders use. */
  estimatedTokens: number
  /** {@link AGENT_DESCRIPTION_TOKEN_BUDGET}. Carried so a reader need not know it. */
  limit: number
  /**
   * The definitions that make up the sum, largest first, each with its own
   * estimate.
   *
   * **A DELIBERATE DIVERGENCE FROM THE DOCUMENTED SURFACE, stated as one.**
   * Neither the binary's notice nor the page names offenders — both give a total
   * and a generic "ask Claude to trim agent descriptions in `.claude/agents/`".
   * We have the per-agent numbers in hand at this seam and a user cannot act on
   * a total, so they are carried. It is an addition, not parity.
   */
  offenders: readonly { name: string; file: string; estimatedTokens: number }[]
}

/**
 * Whether a definition is one of OURS — the class the binary excludes as
 * `source !== "built-in"` and the page excludes as "except the built-in ones".
 *
 * Read off the resource scope, the same discriminator
 * {@link UNGATED_AGENT_HOOK_SCOPES} reads: a plugin-bundled agent carries a
 * `pluginInstanceId` and is never built-in.
 */
/**
 * The description this agent actually costs the turn — read from the FILE, with
 * the descriptor's value as the fallback.
 *
 * **A premise correction, measured at HEAD (P6.315), itself corrected by
 * P6.602.** The re-zoning note said the sum was computable off the descriptor
 * because `buildPiRuntimeAgentDescriptor` "parses the frontmatter". It did not,
 * for this field: the descriptor's `description` is `agent.description` copied
 * verbatim off the runtime VIEW, and the capability resolver gave every native
 * `.claude/agents/*.md` agent `description: ''`. That was the separate finding
 * this docblock named, and P6.602 fixed it at its own seam — `native-sources.ts`
 * now pins the frontmatter `description` onto the record, so the descriptor's
 * value is the declared one and this function's fallback agrees with the file
 * rather than papering over it.
 *
 * The read below stays, and is now belt-and-braces rather than a workaround: it
 * is the only path that can see a description on a definition reaching this seam
 * from somewhere other than a native record. Keeping it costs one parse of bytes
 * already in hand and removes the class of bug where the two disagree.
 */
function agentDescriptionFor(
  definition: PiRuntimeAgentDefinitionDescriptor,
  content: string,
): string {
  const { frontmatter } = splitMarkdownFrontmatter(content)
  const declared = frontmatter.description
  return typeof declared === 'string' && declared.trim() ? declared : definition.description
}

function agentIsBuiltIn(agent: AgentRuntimeView['agents'][number]): boolean {
  const resource = agent.instructionsResource
  if ('pluginInstanceId' in resource) return false
  return resource.scope?.kind === 'builtin'
}

function definitionFileOf(agent: AgentRuntimeView['agents'][number]): string {
  const resource = agent.instructionsResource
  if ('pluginInstanceId' in resource) return `${resource.pluginInstanceId}/${resource.relativePath}`
  return resource.absolutePath || agent.key
}

/**
 * P6.317 (2) — the key a `--agents` definition is addressed by.
 *
 * Prefixed rather than bare so a session agent can never collide with a
 * capability key the resolver minted, and so a reader looking at a descriptor,
 * a log line or a child-session record can see where the definition came from
 * without a second field. The model still invokes it by NAME: session agents
 * carry `selectedAsUnqualifiedAlias: true` (see below).
 */
export const SESSION_AGENT_KEY_PREFIX = 'agent.session.'

/**
 * P6.317 (2) — build ONE descriptor from a `--agents` JSON entry.
 *
 * ## Why this is not the file route with a fake file
 *
 * `buildPiRuntimeAgentDescriptor` reads a MARKDOWN document: every scalar
 * arrives as a string from a line-based frontmatter splitter (P6.648), so
 * `background: true` is the text `"true"` and a nested `hooks` mapping is opaque
 * to it. A caller's JSON already carries real types. Rendering the JSON back
 * into frontmatter so the string parsers could re-read it would put a
 * hand-written YAML emitter between the caller and the validator, and every
 * quoting bug in it would present as a rejected agent.
 *
 * So the fields are read from JSON — through THE SAME validators the wire parse
 * (`parseDefinitionEntry`) uses, name for name, so a value refused in a
 * `.claude/agents/*.md` file is refused here with the same message. The one
 * exception is `hooks`, which is handed to `parseSubagentFrontmatterHooks`
 * through a two-line synthetic document: JSON is a subset of YAML, so
 * `JSON.stringify` of the block is a valid flow mapping and the real YAML reader
 * — the same one the file route uses — does the parsing. No second hook parser.
 *
 * ## The two trust rules, and they are EXEMPTIONS here
 *
 * `sub-agents.md`, § *Hooks in subagent frontmatter*, verbatim: *"Hooks from
 * user-level subagents in `~/.claude/agents/`, from the `--agents` flag or the
 * SDK `agents` option, and from managed settings run without this step."* And
 * the `<span id="inline-server-trust" />` anchor states the same split for
 * inline servers: a PROJECT folder's inline server loads *"only after you trust
 * the folder the agent file came from"*, while the user-level, `--agents`/SDK
 * and managed scopes load with no check.
 *
 * A `--agents` definition has no folder at all — it came from the command line
 * of the person running the app — so both gates are ABSENT rather than open:
 * this route never consults `projectTrusted` and never emits
 * `onUntrustedComponentSkipped`. `mcpServerInlineTrusted` is stamped `true` for
 * the same reason the host stamps it on any ungated definition — P6.816 requires
 * the host's verdict to travel with the map, and this IS the verdict.
 *
 * ## Precedence
 *
 * Rank 2 of {@link AGENT_DEFINITION_SCOPE_PRIORITY} (`'session'`), which is the
 * page's own table: *"Managed settings 1 (highest), `--agents` CLI flag 2,
 * `.claude/agents/` 3, `~/.claude/agents/` 4, plugin `agents/` 5 (lowest)"*.
 * Applied by the caller, {@link materializePiRuntimeAgentDefinitions}, because
 * precedence is a property of the LIST and not of one entry.
 */
function buildSessionAgentDescriptor(
  agentName: string,
  entry: SessionAgentDefinitionV1,
  view: Pick<AgentRuntimeView, 'generation' | 'skills' | 'mcpServers' | 'sources'>,
): PiRuntimeAgentDefinitionDescriptor {
  const label = `agents.${agentName}`
  const name = boundedString(agentName, `${label}.name`, MAX_AGENT_NAME_LENGTH)
  const key = `${SESSION_AGENT_KEY_PREFIX}${name}`
  if (key.length > MAX_AGENT_KEY_LENGTH) throw new Error(`Invalid ${label}.name: key exceeds ${MAX_AGENT_KEY_LENGTH} characters`)
  // `boundedString` already refuses a non-string and a whitespace-only value
  // with the FIELD's own label (`Invalid agents.<name>.prompt: expected string`
  // / `: expected non-empty string`), which is the wording the file route uses
  // for every other field — so there is no second emptiness check here. The
  // byte check below is not a duplicate of its length check: `boundedString`
  // counts UTF-16 code units and the budget is bytes.
  const systemPrompt = boundedString(entry.prompt, `${label}.prompt`, MAX_AGENT_PROMPT_BYTES)
  if (Buffer.byteLength(systemPrompt, 'utf8') > MAX_AGENT_PROMPT_BYTES) {
    throw new Error(`Invalid ${label}.prompt: exceeds ${MAX_AGENT_PROMPT_BYTES} bytes`)
  }
  const description = entry.description === undefined
    ? ''
    : boundedString(entry.description, `${label}.description`, MAX_AGENT_DESCRIPTION_LENGTH, { allowEmpty: true })
  const tools = parseDeclaredTools(entry.tools, `${label}.tools`)
  const disallowedTools = parseTools(entry.disallowedTools, `${label}.disallowedTools`)
  const model = entry.model === undefined
    ? undefined
    : boundedString(entry.model, `${label}.model`, MAX_AGENT_NAME_LENGTH)
  const effort = entry.effort === undefined ? undefined : normalizeThinkingLevel(entry.effort)
  if (entry.effort !== undefined && !effort) throw new Error(`Invalid ${label}.effort`)
  const maxTurns = entry.maxTurns as number | undefined
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    throw new Error(`Invalid ${label}.maxTurns`)
  }
  const permissionMode = typeof entry.permissionMode === 'string'
    ? parsePermissionMode(entry.permissionMode) ?? undefined
    : undefined
  if (entry.permissionMode !== undefined && !permissionMode) throw new Error(`Invalid ${label}.permissionMode`)
  const skillKeys = resolveReferences(parseTools(entry.skills, `${label}.skills`), view.skills, 'skill')
  // `optionalMcpServerList` reads a JSON ARRAY STRING and already splits name
  // references from inline definitions, with the page's own refusals. Handing it
  // `JSON.stringify` of the caller's array is not a re-render: it is the exact
  // input that reader was written for, and it keeps one implementation of
  // "which of these entries is a name and which is a server".
  const requestedMcpServers = entry.mcpServers === undefined
    ? { keys: undefined, inline: undefined }
    : optionalMcpServerList(JSON.stringify(entry.mcpServers), `${label}.mcpServers`)
  const mcpServerKeys = resolveReferences(requestedMcpServers.keys, mcpReferenceCandidates(view), 'MCP server')
  const memory = entry.memory === undefined
    ? undefined
    : AGENT_MEMORY_SCOPE_VALUES.find(scope => scope === entry.memory)
  if (entry.memory !== undefined && !memory) throw new Error(`Invalid ${label}.memory`)
  if (entry.background !== undefined && typeof entry.background !== 'boolean') {
    throw new Error(`Invalid ${label}.background`)
  }
  const background = entry.background as boolean | undefined
  const isolation = entry.isolation === undefined
    ? undefined
    : entry.isolation === 'worktree' ? 'worktree' as const : undefined
  if (entry.isolation !== undefined && !isolation) throw new Error(`Invalid ${label}.isolation`)
  const initialPrompt = entry.initialPrompt === undefined
    ? undefined
    : boundedString(entry.initialPrompt, `${label}.initialPrompt`, MAX_AGENT_INITIAL_PROMPT_LENGTH).trim() || undefined
  const componentHooks = entry.hooks === undefined
    ? undefined
    : parseSubagentFrontmatterHooks(`---\nhooks: ${JSON.stringify(entry.hooks)}\n---\n`)
  const descriptor = {
    schemaVersion: 2 as const,
    key,
    name,
    description,
    // TRUE, and it is the whole point of the flag: the caller named the agent,
    // so the model invokes it by that name. `claude-runtime-agents.ts` keys the
    // SDK's `Record<string, AgentDefinition>` by `name` when this is set, and
    // Pi registers `name` rather than `key` under the same rule.
    selectedAsUnqualifiedAlias: true,
    systemPrompt,
    sha256: sha256(systemPrompt),
    provenance: `${key}@${view.generation}`,
    capabilityGeneration: view.generation,
    ...(model ? { model } : {}),
    // Same per-field reading as both other routes: `tools` keeps an
    // authored-empty set (P2.202), `disallowedTools` collapses it.
    ...(tools ? { tools: [...tools] } : {}),
    ...(disallowedTools && disallowedTools.length > 0 ? { disallowedTools: [...disallowedTools] } : {}),
    ...(effort ? { effort } : {}),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(permissionMode ? { permissionMode } : {}),
    ...(skillKeys ? { skillKeys } : {}),
    ...(mcpServerKeys ? { mcpServerKeys } : {}),
    ...(memory ? { memory } : {}),
    ...(background === undefined ? {} : { background }),
    ...(isolation ? { isolation } : {}),
    // The last four keys, in lockstep with the other two producers — see the
    // ordering note on the descriptor interface. Key ORDER is load-bearing here
    // and not only there: `definitionDigest` is `sha256(JSON.stringify(...))`,
    // and `parseDefinitionEntry` recomputes it over its own key order, so a
    // descriptor built in a different order would fail its own digest check the
    // moment it reached the wire.
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(componentHooks ? { componentHooks } : {}),
    ...(requestedMcpServers.inline ? { mcpServerInline: requestedMcpServers.inline } : {}),
    ...(requestedMcpServers.inline ? { mcpServerInlineTrusted: true as const } : {}),
  }
  return { ...descriptor, definitionDigest: definitionDigest(descriptor) }
}

/**
 * Materialize the runtime view's agent definitions PER ENTRY: a valid
 * definition loads, a malformed one is EXCLUDED with a diagnostic naming the
 * file and the reason, and the turn proceeds with the survivors. This used to
 * throw on the first bad entry — measured live 2026-07-31, one `tools: []`
 * file in `~/.nessy-agent/agents/` made every send in every session die
 * inside `SessionManager.getOrCreateAgentUnchecked`. Claude's own loader
 * treats a malformed subagent definition as that agent's problem, not the
 * session's (sub-agents.md), and the skills loader in this repo already
 * follows the same lenient-load/strict-validate split.
 */
export async function materializePiRuntimeAgentDefinitions(input: {
  view: AgentRuntimeView
  materializer: CapabilitySnapshotMaterializer
  onInvalidDefinition?: (diagnostic: PiRuntimeAgentDefinitionDiagnostic) => void
  /**
   * R87b — whether this session's project folder carries the workspace trust
   * grant. It gates a PROJECT-scoped definition's frontmatter hooks and nothing
   * else: the definition still loads either way.
   *
   * It also enters the definition DIGEST through `componentHooks`, so every call
   * site that pins definitions for one capability generation must pass the same
   * value or the host's pinned descriptor and the subprocess's copy hash
   * differently and every spawn fails `runtime-agent-definition-identity-mismatch`.
   */
  projectTrusted?: boolean
  /**
   * A definition whose FRONTMATTER declared something the folder-trust grant did
   * not cover. `sub-agents.md`: Claude "logs an error to the debug log
   * explaining how to trust the folder" — the agent is unaffected either way.
   *
   * Two reasons ride this channel, because `sub-agents.md` states two rules over
   * one scope split: the `hooks` block (§ *Hooks in subagent frontmatter*) and
   * an inline `mcpServers` entry (the `<span id="inline-server-trust" />`
   * anchor). The payload is a plain `{ file, reason }` and both consumers log
   * exactly that, so the reason text carries the distinction. **P6.834 widened
   * the NAME to match, once the two consumers (`SessionManager.ts`,
   * `pi-agent.ts`) were free**: it was `onFrontmatterHooksSkipped`, one word too
   * narrow, and the rename waited rather than shipping half — a rename that
   * cannot reach every consumer splits one diagnostic across two channels, one
   * of them unwired, which is a silent gap in place of a slightly wrong name.
   *
   * The name is now the SUBJECT both rules share — a component of this agent's
   * definition withheld because the project folder it came from is not trusted —
   * rather than one of the two things withheld. A third such rule needs no third
   * channel and no third rename.
   */
  onUntrustedComponentSkipped?: (diagnostic: PiRuntimeAgentDefinitionDiagnostic) => void
  /**
   * P6.315 — the non-built-in descriptions together exceed
   * {@link AGENT_DESCRIPTION_TOKEN_BUDGET}. Fired at most once per call, AFTER
   * the definitions are built, and never as a gate: every definition still
   * loads, which is the page's own promise.
   */
  onDescriptionsOverBudget?: (diagnostic: PiRuntimeAgentDescriptionBudgetDiagnostic) => void
  /**
   * P6.317 (2) — the `--agents` JSON, keyed by agent name, for THIS session.
   *
   * Nothing is written to disk and nothing enters the capability snapshot: these
   * definitions exist for the life of the session that was started with them,
   * which is the flag's documented shape and the whole value of it (automation
   * and headless runs).
   *
   * IT ENTERS THE DEFINITION DIGEST, exactly as `projectTrusted` does, so every
   * call site that pins definitions for one capability generation must pass the
   * SAME value or the host's pinned descriptor and the subprocess's copy hash
   * differently and every spawn fails `runtime-agent-definition-identity-mismatch`.
   * On the host the session-scoped value therefore travels at every one of those
   * call sites beside `agentDefinitionHookTrust`'s spread (`SessionManager.ts`),
   * which is the existing answer to the same problem for `projectTrusted`.
   */
  sessionAgents?: Readonly<Record<string, SessionAgentDefinitionV1>>
}): Promise<readonly PiRuntimeAgentDefinitionDescriptor[]> {
  const definitions: PiRuntimeAgentDefinitionDescriptor[] = []
  /**
   * Parallel to `definitions`, so a failure index from the final wire parse maps
   * back to the definition the diagnostic must name.
   *
   * A RECORD rather than the view agent itself, because a `--agents` definition
   * has no view entry and no file: `file` is what the user would open (or, for a
   * session agent, the flag entry they typed), and `builtIn` is the P6.315
   * discriminator that used to be re-derived from the agent.
   */
  const definitionSources: { key: string; name: string; file: string; builtIn: boolean }[] = []
  // P6.315 · parallel too. The DESCRIPTION cannot be read off the descriptor —
  // see {@link agentDescriptionFor} — so the file's own text is kept. A session
  // agent has no file, and its descriptor's description IS the declared one, so
  // it contributes an empty string and `agentDescriptionFor` falls back to it.
  const definitionContents: string[] = []
  // P6.317 (2) — the `--agents` rung is applied FIRST, and it is rank 2 of
  // `AGENT_DEFINITION_SCOPE_PRIORITY`: `sub-agents.md#choose-the-subagent-scope`
  // — *"When multiple subagents share the same name, Claude Code uses the one
  // from the higher-priority location."* — over Managed 1, `--agents` 2,
  // `.claude/agents/` 3, `~/.claude/agents/` 4, plugin `agents/` 5.
  //
  // RESIDUE, stated rather than silently taken (P6.902): this fork's loader
  // cannot separate the MANAGED rung from the workspace one — the view's agents
  // arrive as one list — so a `--agents` definition displaces a same-named
  // managed one too, where the page puts managed first. That is one rung of
  // over-reach on a flag only the person running the binary can pass.
  const sessionAgentNames = new Set<string>()
  for (const [agentName, entry] of Object.entries(input.sessionAgents ?? {})) {
    try {
      const descriptor = buildSessionAgentDescriptor(agentName, entry, input.view)
      definitions.push(descriptor)
      definitionContents.push('')
      definitionSources.push({
        key: descriptor.key,
        name: descriptor.name,
        file: `--agents ${descriptor.name}`,
        builtIn: false,
      })
      sessionAgentNames.add(descriptor.name)
    } catch (error) {
      input.onInvalidDefinition?.({
        agentKey: `${SESSION_AGENT_KEY_PREFIX}${agentName}`,
        agentName,
        file: `--agents ${agentName}`,
        reason: reasonOf(error),
      })
    }
  }
  for (const agent of input.view.agents) {
    // Displaced by a same-named session agent — not an error and not a
    // diagnostic: it is the documented precedence doing its job.
    if (sessionAgentNames.has(agent.name)) continue
    try {
      const content = await input.materializer.readText(agent.instructionsResource)
      definitionContents.push(content)
      definitions.push(buildPiRuntimeAgentDescriptor(agent, content, input.view, {
        resolveCapabilityReferences: true,
        ...(input.projectTrusted === undefined ? {} : { projectTrusted: input.projectTrusted }),
        onUntrustedComponentSkipped: reason => input.onUntrustedComponentSkipped?.({
          agentKey: agent.key,
          agentName: agent.name,
          file: definitionFileOf(agent),
          reason,
        }),
      }))
      definitionSources.push({
        key: agent.key,
        name: agent.name,
        file: definitionFileOf(agent),
        builtIn: agentIsBuiltIn(agent),
      })
    } catch (error) {
      input.onInvalidDefinition?.({
        agentKey: agent.key,
        agentName: agent.name,
        file: definitionFileOf(agent),
        reason: reasonOf(error),
      })
    }
  }
  const parsed = parsePiRuntimeAgentDefinitions(definitions, {
    onInvalid: failure => {
      const agent = definitionSources[failure.index]
      input.onInvalidDefinition?.({
        agentKey: agent?.key ?? failure.key ?? `piRuntimeAgentDefinitions[${failure.index}]`,
        agentName: agent?.name ?? failure.name ?? '',
        file: agent?.file ?? `piRuntimeAgentDefinitions[${failure.index}]`,
        reason: failure.reason,
      })
    },
  })
  // P6.315 · measured on the SURVIVORS, and over `definitionSources` rather than
  // over `parsed`: an excluded definition costs no context, and the source array
  // is what carries the built-in discriminator. A definition dropped by the wire
  // parse above is over-counted here, which is the fail-loud direction for a
  // report that changes nothing.
  if (input.onDescriptionsOverBudget) {
    const offenders = definitions
      .map((definition, index) => ({
        name: definition.name,
        agent: definitionSources[index],
        // The binary's own subject: the agent's NAME plus its description, not
        // the description alone.
        estimatedTokens: estimateTokens(
          `${definition.name}: ${agentDescriptionFor(definition, definitionContents[index] ?? '')}`,
        ),
      }))
      .filter(entry => entry.agent !== undefined && !entry.agent.builtIn)
      .map(entry => ({
        name: entry.name,
        file: entry.agent!.file,
        estimatedTokens: entry.estimatedTokens,
      }))
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens)
    const estimatedTokens = offenders.reduce((total, entry) => total + entry.estimatedTokens, 0)
    if (estimatedTokens > AGENT_DESCRIPTION_TOKEN_BUDGET) {
      input.onDescriptionsOverBudget({
        estimatedTokens,
        limit: AGENT_DESCRIPTION_TOKEN_BUDGET,
        offenders,
      })
    }
  }
  return parsed
}

/**
 * Session-free strict validation of ONE agent definition file's content — the
 * `skill_validate`-style loud half of the lenient runtime contract above. The
 * send path EXCLUDES a malformed definition and proceeds; this refuses with
 * the reason, so doctor-class surfaces can name the file and field before
 * send time. Capability references (`skills`, `mcpServers`) cannot be
 * resolved without a live snapshot, so only their shape is checked here.
 */
export function validatePiRuntimeAgentDefinitionContent(input: {
  name: string
  content: string
}): { ok: true } | { ok: false; reason: string } {
  const agent: AgentRuntimeView['agents'][number] = {
    key: `agent.${input.name}`,
    name: input.name,
    description: '',
    instructionsResource: {
      source: 'shared-personal',
      scope: { kind: 'global' },
      resourceId: input.name,
      absolutePath: '',
      revision: '',
      contentHash: '',
    },
  }
  try {
    const descriptor = buildPiRuntimeAgentDescriptor(
      agent,
      input.content,
      { generation: 'validate', skills: [], mcpServers: [], sources: [] },
      { resolveCapabilityReferences: false },
    )
    let reason: string | undefined
    const parsed = parsePiRuntimeAgentDefinitions([descriptor], {
      onInvalid: failure => { reason = failure.reason },
    })
    return parsed.length === 1 ? { ok: true } : { ok: false, reason: reason ?? 'invalid agent definition' }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}

function buildPiRuntimeAgentDescriptor(
  agent: AgentRuntimeView['agents'][number],
  content: string,
  view: Pick<AgentRuntimeView, 'generation' | 'skills' | 'mcpServers' | 'sources'>,
  options: {
    resolveCapabilityReferences: boolean
    /**
     * R87b — whether the folder a PROJECT-scoped definition came from carries
     * the workspace trust grant. Only that scope consults it; user-level and
     * workspace definitions run their hooks "without this step".
     */
    projectTrusted?: boolean
    /** Reports a definition whose hooks were skipped for want of that grant. */
    onUntrustedComponentSkipped?: (reason: string) => void
  },
): PiRuntimeAgentDefinitionDescriptor {
  {
    const { body, frontmatter: rawFrontmatter } = splitMarkdownFrontmatter(content)
    const frontmatter = withPluginExclusions(rawFrontmatter, agent)
    // The same three fields are dropped on the host-supplied route too. The
    // resolver never populates them for an agent today, so this costs nothing
    // now and keeps the rule from depending on that staying true.
    const pluginScoped = isPluginSubagent(agent)
    const systemPrompt = body.trim()
    if (!systemPrompt) throw new Error(`Agent "${agent.name}" has no instructions`)
    const tools = agent.tools ?? optionalToolList(frontmatter.tools, `${agent.key}.tools`)
    const disallowedTools = agent.disallowedTools
      ?? optionalToolList(
        frontmatter.disallowedTools ?? frontmatter['disallowed-tools'],
        `${agent.key}.disallowedTools`,
      )
    const requestedSkills = agent.skillKeys ?? optionalStringList(frontmatter.skills, `${agent.key}.skills`)
    const skillKeys = options.resolveCapabilityReferences
      ? resolveReferences(requestedSkills, view.skills, 'skill')
      : asOmittedWhenEmpty(requestedSkills)
    // P6.808 — the frontmatter list is read ONCE and split into its two
    // documented shapes. The `pluginScoped || agent.mcpServerKeys` guard keeps
    // the short-circuit the `??` chain used to provide: when the resolved view
    // has already answered, the frontmatter is not read at all, so a malformed
    // list there still cannot refuse an agent whose servers came from the view.
    const frontmatterMcpServers = pluginScoped || agent.mcpServerKeys
      ? undefined
      : optionalMcpServerList(frontmatter.mcpServers ?? frontmatter['mcp-servers'], `${agent.key}.mcpServers`)
    const requestedMcpServers = pluginScoped
      ? undefined
      : agent.mcpServerKeys ?? frontmatterMcpServers?.keys
    // Carried, not resolved: an inline entry names a server to START, not one to
    // look up in the view, so `resolveReferences` must never see it.
    //
    // P6.792 — and START is why it is gated. `sub-agents.md`'s
    // `<span id="inline-server-trust" />`: an inline server from a PROJECT
    // folder loads *"only after you trust the folder the agent file came
    // from"*, while a name reference and an inline server from the user-level,
    // `--agents`/SDK or managed scopes load with no check. That scope split is
    // {@link subagentHookScope}'s, already computed below for the sibling hooks
    // rule (`sub-agents.md`, § *Hooks in subagent frontmatter*) — one scope
    // question, two frontmatter fields that read it.
    //
    // Skipped, never fatal: *"Claude Code skips every inline server in that
    // agent file"* and the agent itself still runs, the same shape the hooks
    // gate takes.
    //
    // P6.835 said THE BUNDLE LAGS THE PAGE HERE and asked to be re-measured at
    // the SDK lift. **The lift happened and the direction has FLIPPED**
    // (C3.252, 2026-09-12; the twin verdict is C3.142's on
    // `agents/definitions.ts`'s `mcpServerInlineTrusted`, 2026-09-11). The
    // section's last sentence, verbatim (fetched 2026-09-08, anchor re-verified
    // on the RENDERED page: `id="inline-server-trust"` is present among its 490
    // published ids): *"Before v2.1.238, Claude Code loaded these servers
    // without checking trust."* The child we vendor self-reports **2.1.247** on
    // both of its own reports — `"claudeCodeVersion": "2.1.247"` in the SDK
    // manifest and `claude --version` -> `2.1.247 (Claude Code)` — which is
    // PAST v2.1.238, where it was 2.1.233 and five patch versions short when
    // P6.835 wrote this. Read the two self-reports, never a grep of the binary
    // for a dotted version, which counts build constants (AGENTS.md §"docs are
    // the contract for BEHAVIOUR, not for MEMBERSHIP").
    //
    // So this gate is no longer the page leading the bundle. It is our own
    // FAIL-CLOSED reading beside a check the binary already performs, and that
    // is deliberate rather than redundant: our verdict comes from the
    // host-supplied capability snapshot, where a descriptor built without
    // consulting trust arrives with a map and no verdict.
    //
    // C3.324 (2026-09-12) SETTLED P6.835's open question — which of the two
    // enforcers is the seam. **This one is, and the child's is not something it
    // can be pinned TO, because on every runtime we ship the two judge DISJOINT
    // inputs.** Three measured arms:
    //
    //  - On claude the inline map is never forwarded at all.
    //    `agent/claude-runtime-agents.ts` sends the resolved NAME-REFERENCE form
    //    only, and the page's own trust section exempts that form BY NAME: *"A
    //    name that references a server you already configured"* is one of the
    //    two kinds loaded without checking folder trust. Nothing this gate
    //    admits ever reaches the child's gate.
    //  - The child's gate would refuse it anyway, and the page says so in the
    //    clause neither this docblock nor its twin carried: *"**Trust that
    //    doesn't count**: a parent folder's trust, and the automatic trust a
    //    `-p` or SDK session gets for [hooks in settings files]"*. WE ARE AN SDK
    //    SESSION. What the child wants instead is
    //    `projects["<path>"].hasTrustDialogAccepted` in `~/.claude.json` — a key
    //    it really carries (10 lines / 16 occurrences in the vendored 2.1.247
    //    binary, `grep -ac` and `grep -ao … | wc -l` respectively; control
    //    `nessyNotARealSdkKey` 0/0) — and since F1.789 one the HOST writes for
    //    the MAIN child's folder trust on every chatImpl turn
    //    (`agent/backend/claude/project-trust-entry.ts`), superseding this
    //    bullet's 2026-09-12 "the fork writes it NOWHERE" grep measurement —
    //    arm 1 above (the name-reference exemption) is unchanged by that.
    //  - On Pi and codex there is no second enforcer at all, so this gate is the
    //    only one there is.
    //
    // Both are therefore fail-closed in the SAME direction over inputs that
    // never meet — the "honest rather than uniform" half of the native-first
    // rule: nothing is unified because there is no shared input to unify. What
    // IS pinned is the DISJOINTNESS.
    // `agent/__tests__/claude-subagent-mcp-wire-names.test.ts` § C3.324 goes red
    // the day a descriptor's inline map is forwarded to the SDK, so the trust
    // question cannot be reopened silently.
    const inlineServersTrusted = mcpServerInlineScope(agent) !== 'project' || options.projectTrusted === true
    const mcpServerInline = inlineServersTrusted ? frontmatterMcpServers?.inline : undefined
    if (frontmatterMcpServers?.inline && !inlineServersTrusted) {
      options.onUntrustedComponentSkipped?.(
        'inline mcpServers skipped: the project folder this agent came from is not trusted. '
        + 'Accept the workspace trust dialog for that folder to let them start; name references '
        + 'in the same list still resolve, and the agent itself still runs.',
      )
    }
    const mcpServerKeys = options.resolveCapabilityReferences
      // Bare-name aliases for plugin servers (T3), only when unambiguous, and
      // ambiguity counted across `mcpServers` AND `sources` — see
      // {@link mcpReferenceCandidates}, which the `--agents` route shares.
      ? resolveReferences(requestedMcpServers, mcpReferenceCandidates(view), 'MCP server')
      : asOmittedWhenEmpty(requestedMcpServers)
    const model = agent.model ?? frontmatter.model
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
      throw new Error(`Invalid ${agent.key}.model`)
    }
    const tierText = agent.tier ?? frontmatter.tier
    if (tierText !== undefined && !['small', 'medium', 'big'].includes(tierText)) {
      throw new Error(`Invalid ${agent.key}.tier`)
    }
    const tier = tierText as AgentTier | undefined
    const effortText = frontmatter.effort
    const effort = agent.effort ?? normalizeThinkingLevel(effortText)
    if (agent.effort === undefined && effortText !== undefined && effort === undefined) {
      throw new Error(`Invalid ${agent.key}.effort`)
    }
    const maxTurnsText = frontmatter.maxTurns ?? frontmatter['max-turns']
    // P6.565 · `/^\d+$/` STAYS, and that is a reading rather than an omission.
    // `env-vars.md#variables`' general clause — which grants `2e3` and `64_000`
    // to the readers this row converted — opens with *"Numeric variables such as
    // timeouts, token budgets, and retry counts…"*: it is scoped to ENVIRONMENT
    // VARIABLES. This is subagent FRONTMATTER, and its own page row
    // (`sub-agents.md#supported-frontmatter-fields`, *"Maximum number of agentic
    // turns before the subagent stops…"*) says nothing about numeric spelling at
    // all. Widening it here would be inventing a contract for a surface no page
    // describes — and it would change what a subagent file MEANS, silently, on
    // every runtime that reads one.
    const parsedMaxTurns = maxTurnsText !== undefined && /^\d+$/.test(maxTurnsText)
      ? Number(maxTurnsText)
      : undefined
    if (agent.maxTurns === undefined && maxTurnsText !== undefined
      && (!Number.isSafeInteger(parsedMaxTurns) || (parsedMaxTurns as number) < 1)) {
      throw new Error(`Invalid ${agent.key}.maxTurns`)
    }
    const maxTurns = agent.maxTurns ?? parsedMaxTurns
    const permissionModeText = frontmatter.permissionMode ?? frontmatter['permission-mode']
    const parsedPermissionMode = permissionModeText === undefined ? undefined : parsePermissionMode(permissionModeText) ?? undefined
    if (agent.permissionMode === undefined && permissionModeText !== undefined && parsedPermissionMode === undefined) {
      throw new Error(`Invalid ${agent.key}.permissionMode`)
    }
    // `permissionModeText` is already `undefined` for a plugin subagent — the
    // key was stripped above — so only the host-supplied route is left to drop.
    const permissionMode = pluginScoped ? undefined : agent.permissionMode ?? parsedPermissionMode
    // Frontmatter delivers every scalar as a string, so `background: true`
    // arrives as `"true"`; the descriptor carries a real boolean.
    const memoryText = frontmatter.memory
    const memory = memoryText === undefined
      ? undefined
      : AGENT_MEMORY_SCOPE_VALUES.find(scope => scope === memoryText.trim().toLowerCase())
    if (memoryText !== undefined && !memory) throw new Error(`Invalid ${agent.key}.memory`)
    const backgroundText = frontmatter.background
    const background = backgroundText === undefined
      ? undefined
      : backgroundText.trim().toLowerCase() === 'true'
        ? true
        : backgroundText.trim().toLowerCase() === 'false' ? false : undefined
    if (backgroundText !== undefined && background === undefined) {
      throw new Error(`Invalid ${agent.key}.background`)
    }
    const colorText = frontmatter.color
    const color = colorText === undefined
      ? undefined
      : AGENT_COLORS.find(value => value === colorText.trim().toLowerCase())
    if (colorText !== undefined && !color) throw new Error(`Invalid ${agent.key}.color`)
    const isolationText = frontmatter.isolation
    const isolation = isolationText === undefined
      ? undefined
      : isolationText.trim().toLowerCase() === 'worktree' ? 'worktree' as const : undefined
    if (isolationText !== undefined && !isolation) throw new Error(`Invalid ${agent.key}.isolation`)
    // `splitMarkdownFrontmatter` carries no block-scalar support either, so
    // `initialPrompt: |` arrives here as the literal "|". An unrepresentable
    // value is OMITTED, never rejected — the same call the markdown loader's
    // `normalizeInitialPrompt` makes, and for the same reason: our flat parser's
    // limit must not delete an imported agent over a field nothing consumes yet.
    const initialPromptText = frontmatter.initialPrompt ?? frontmatter['initial-prompt']
    const initialPrompt = initialPromptText === undefined || isYamlBlockScalarIndicator(initialPromptText)
      ? undefined
      : initialPromptText.trim() || undefined
    if (initialPrompt !== undefined && initialPrompt.length > MAX_AGENT_INITIAL_PROMPT_LENGTH) {
      throw new Error(`Invalid ${agent.key}.initialPrompt: exceeds ${MAX_AGENT_INITIAL_PROMPT_LENGTH} characters`)
    }
    // R87b — the frontmatter `hooks` block. `rawFrontmatter` is read rather than
    // the plugin-scoped copy because the DECLARATION must still be visible when
    // the key has been stripped: a plugin subagent that declares hooks is told
    // so by the format adapter's diagnostic, and a project definition whose
    // folder is untrusted has to be reported here.
    //
    // `splitMarkdownFrontmatter` leaves a nested mapping as the key with an
    // empty value, so presence of the key is the whole test — the block itself
    // is read by `parseSubagentFrontmatterHooks` with a real YAML reader.
    const hookScope = subagentHookScope(agent)
    const declaresHooks = 'hooks' in rawFrontmatter
    let componentHooks: SubagentComponentHooks | undefined
    if (declaresHooks && hookScope === 'project' && options.projectTrusted !== true) {
      // "the subagent still runs, but Claude Code skips its frontmatter hooks
      // and logs an error to the debug log explaining how to trust the folder."
      // Reported, never thrown: refusing the definition would contradict the
      // page.
      options.onUntrustedComponentSkipped?.(
        'frontmatter hooks skipped: the project folder this agent came from is not trusted. '
        + 'Accept the workspace trust dialog for that folder to let them run; the agent itself still runs.',
      )
    } else if (declaresHooks && hookScope !== 'plugin') {
      componentHooks = parseSubagentFrontmatterHooks(content)
    }
    // F1.1203 — see the descriptor field; `.claude/agents` copies only. F1.1211 — read
    // from the frontmatter as Claude Code parses it, not from our lenient scanner.
    const claudeAgentName = isClaudeProjectAgentCopyKey(agent.key)
      ? claudeCodeLoadedAgentName(claudeCodeParsedFrontmatter(content))
      : undefined
    const descriptor = {
      schemaVersion: 2 as const,
      key: agent.key,
      name: agent.name,
      description: agent.description,
      selectedAsUnqualifiedAlias: agent.selectedAsUnqualifiedAlias === true,
      systemPrompt,
      sha256: sha256(systemPrompt),
      provenance: `${agent.key}@${view.generation}`,
      capabilityGeneration: view.generation,
      ...(model ? { model } : {}),
      // P2.202 — this WAS the second half of the empty-means-absent collapse,
      // and the row that found it named only the wire parse. `optionalToolList`
      // already answers correctly on both sides of the distinction (`[]` for
      // every authored-empty spelling, `undefined` for an absent key); the
      // `.length > 0` guard that stood here threw that answer away BEFORE
      // `parseTools` could be blamed for it, which is why fixing the wire parse
      // alone changed nothing observable. Per-field, matching
      // `parseDeclaredTools`: `tools` keeps the empty set, `disallowedTools`
      // collapses it, because an empty denylist denies nothing.
      ...(tools ? { tools: [...tools] } : {}),
      ...(disallowedTools && disallowedTools.length > 0 ? { disallowedTools: [...disallowedTools] } : {}),
      ...(tier ? { tier } : {}),
      ...(effort ? { effort } : {}),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(permissionMode ? { permissionMode } : {}),
      ...(skillKeys ? { skillKeys } : {}),
      ...(mcpServerKeys ? { mcpServerKeys } : {}),
      ...(memory ? { memory } : {}),
      ...(background === undefined ? {} : { background }),
      ...(color ? { color } : {}),
      ...(isolation ? { isolation } : {}),
      // The last five keys, in lockstep with `parseDefinitionEntry`'s `parsed`.
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(componentHooks ? { componentHooks } : {}),
      ...(mcpServerInline ? { mcpServerInline } : {}),
      ...(mcpServerInline ? { mcpServerInlineTrusted: true as const } : {}),
      ...(claudeAgentName ? { claudeAgentName } : {}),
    }
    return { ...descriptor, definitionDigest: definitionDigest(descriptor) }
  }
}

function asOmittedWhenEmpty(value: readonly string[] | undefined): string[] | undefined {
  return value && value.length > 0 ? [...value] : undefined
}

/**
 * P6.940 (2) — what a PINNED SESSION AGENT gives a Pi session, and what it
 * cannot.
 *
 * `sub-agents.md:297`, verbatim: *"Auto-submitted as the first user turn when
 * this agent runs as the main session agent (via `--agent` or the `agent`
 * setting). Commands and skills are processed. Prepended to any user-provided
 * prompt"*. The claude arm (`pinClaudeMainThreadAgent`) hands the whole job to
 * the SDK's own `Options.agent`, which applies *"the agent's system prompt, tool
 * restrictions, and model … to the main conversation"*.
 *
 * ## Pi has no such option, and that is the row
 *
 * Every `spawner.ts` entry point composes a CHILD, and the harness manifest
 * carries these descriptors for DISPATCH. So the projection is HOST-composed —
 * native-first step 2 rather than step 1 — and it is composed out of the
 * descriptor the host already materializes, not out of a second read of the
 * agent's file.
 *
 * ## Three halves are applied, and every other field is dropped BY NAME
 *
 * - `systemPrompt` → appended to the session's system prefix, where a spawned
 *   child's composed prompt already lands (`pi-agent.ts`).
 * - `tools` → the turn's tool universe (`piAllowedTools`), which P6.217 made a
 *   host-settable ceiling.
 * - `initialPrompt` → submitted once, ahead of the user's own first message.
 *   The descriptor has carried this field since R30c and its own comment said
 *   it was "NOT consumed anywhere yet, because the surface that row names does
 *   not exist in this fork". This is that surface.
 *
 * `model` is withheld for the reason the claude arm withholds it — ledger K7's
 * *one session equals one upstream*: an agent's model on the main thread gives
 * one session two answers to "what model is this?". Every other declared field
 * (`effort`, `permissionMode`, `maxTurns`, `memory`, `isolation`, `background`,
 * `skillKeys`, `mcpServerKeys`, `disallowedTools`) has no main-session
 * expression on this runtime and is announced rather than silently ignored —
 * `disallowedTools` included, because the one Pi field that removes without
 * naming a universe (`piSkillDisallowedTools`) is skill-scoped by contract and
 * reusing it would make its name a lie.
 *
 * An unknown name degrades and never dies, exactly as on claude: a mistyped
 * setting must not become a session that will not start.
 */
export interface PiSessionAgentPin {
  name: string
  systemPrompt: string
  tools?: readonly string[]
  initialPrompt?: string
}

/** The descriptor fields a pinned MAIN-SESSION agent cannot express on Pi. */
const PI_SESSION_AGENT_UNAPPLIED_FIELDS = [
  'model',
  'effort',
  'permissionMode',
  'maxTurns',
  'memory',
  'isolation',
  'background',
  'skillKeys',
  'mcpServerKeys',
  'disallowedTools',
] as const

export function resolvePiSessionAgentPin(
  definitions: readonly PiRuntimeAgentDefinitionDescriptor[] | undefined,
  name: string | undefined,
  onDiagnostic?: (message: string) => void,
): PiSessionAgentPin | undefined {
  const wanted = name?.trim()
  if (!wanted) return undefined
  if (!definitions || definitions.length === 0) {
    onDiagnostic?.(
      `Session agent "${wanted}" was not applied: this session registers no agent definitions.`,
    )
    return undefined
  }
  // By NAME and by KEY: a plugin-scoped definition is addressed by its
  // qualified key, and the setting is a name a person typed.
  const pinned = definitions.find(entry => entry.name === wanted)
    ?? definitions.find(entry => entry.key === wanted)
  if (!pinned) {
    onDiagnostic?.(
      `Session agent "${wanted}" was not applied: this session registers no agent by that name`
      + ` (it has ${definitions.map(entry => entry.name).sort().join(', ')}).`,
    )
    return undefined
  }
  const dropped = PI_SESSION_AGENT_UNAPPLIED_FIELDS
    .filter(field => (pinned as unknown as Record<string, unknown>)[field] !== undefined)
  if (dropped.length > 0) {
    onDiagnostic?.(
      `Session agent "${pinned.name}" declares ${dropped.join(', ')}, which a main-session pin does not apply on Pi;`
      + ' the session keeps its own model, effort, permission mode and limits.',
    )
  }
  return {
    name: pinned.name,
    systemPrompt: pinned.systemPrompt,
    ...(pinned.tools && pinned.tools.length > 0 ? { tools: pinned.tools } : {}),
    ...(pinned.initialPrompt ? { initialPrompt: pinned.initialPrompt } : {}),
  }
}

/**
 * F1.1203 — the name Claude Code loads an agent file under, or `undefined` when
 * it loads none (`sub-agents.md`: no `name` is documentation, a `name` without
 * a `description` is skipped, a name containing `:` is not loaded).
 */
function claudeCodeLoadedAgentName(frontmatter: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const name = typeof frontmatter?.name === 'string' ? frontmatter.name.trim() : undefined
  const description = typeof frontmatter?.description === 'string' ? frontmatter.description.trim() : undefined
  if (!name || !description || name.includes(':')) return undefined
  return name.length <= MAX_AGENT_NAME_LENGTH ? name : undefined
}

/**
 * F1.1211 — an agent file's frontmatter as Claude Code reads it, or `undefined`
 * when Claude Code reads none (and so loads no agent from the file).
 *
 * Measured on the vendored Claude Code 2.1.274 binary (2026-10-09): it parses
 * the block between the `---` fences as YAML; when that throws it tries ONCE
 * more after double-quoting every top-level `key: value` whose unquoted value
 * holds a YAML special character (`{ } [ ] * & # ! | > % @` and a backtick) or
 * a `": "` (a value that is already a quoted string or a parseable flow
 * sequence is left alone) and turning leading tabs into two spaces each; when
 * that throws too it logs "Failed to parse YAML frontmatter" and uses an empty
 * frontmatter. Our {@link splitMarkdownFrontmatter} falls back to a lenient
 * line scanner instead, so it read a `name` from a file Claude loads nothing
 * from, and F1.1203 then dropped the bundled agent of that name. js-yaml's YAML
 * 1.2 core schema stands in for the binary's `Bun.YAML` (they agree on both
 * shapes the tests pin); this module may run outside Bun.
 */
function claudeCodeParsedFrontmatter(content: string): Readonly<Record<string, unknown>> | undefined {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close === -1) return undefined
  const block = lines.slice(1, close).join('\n')
  for (const candidate of [block, claudeCodeQuotedRetry(block)]) {
    try {
      const parsed: unknown = loadYaml(candidate, { schema: CORE_SCHEMA })
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      // The next candidate, then none: Claude Code loads an empty frontmatter.
    }
  }
  return undefined
}

/** The one retry {@link claudeCodeParsedFrontmatter} describes. */
function claudeCodeQuotedRetry(block: string): string {
  return block.split('\n').map(line => {
    const match = /^([a-zA-Z_-]+):\s+(.+)$/.exec(line)
    const value = match?.[2]
    if (!match || value === undefined) return line
    if (/^".*"$|^'.*'$/.test(value) || isYamlFlowSequence(value)) return line
    if (!/[{}[\]*&#!|>%@`]|: /.test(value)) return line
    return `${match[1]}: "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  }).join('\n').replace(/^\t+/gm, tabs => '  '.repeat(tabs.length))
}

function isYamlFlowSequence(value: string): boolean {
  if (!value.startsWith('[') || !value.endsWith(']')) return false
  try {
    return Array.isArray(loadYaml(value, { schema: CORE_SCHEMA }))
  } catch {
    return false
  }
}

// F1.1203 — imported at the end so no line the docs cite by number moves.
import { isClaudeProjectAgentCopyKey } from '../../capabilities/native-sources.ts'
import { CORE_SCHEMA, load as loadYaml } from 'js-yaml' // F1.1211 — appended, hoisted

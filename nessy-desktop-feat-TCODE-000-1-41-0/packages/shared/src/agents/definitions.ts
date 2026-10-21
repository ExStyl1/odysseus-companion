import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { CONFIG_DIR } from '../config/paths.ts';
import { debug } from '../utils/debug.ts';
import { splitToolGrantList } from '../utils/tool-grant-list.ts';
import { parsePermissionMode, type PermissionMode } from '../agent/mode-types.ts';
import { normalizeThinkingLevel, type ThinkingLevel } from '../agent/thinking-levels.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts';

/**
 * Repository instruction files are NEVER agent definitions. `AGENTS.md` (and the
 * `CLAUDE*` variants) are project instruction content, so they must be excluded
 * from any markdown agent-definition scan even if they happen to carry
 * frontmatter (W6 Step 4).
 *
 * This used to be a second copy of that set, and P6.35 taught only the other one
 * `agents.override.md` — the file codex actually reads. Nothing failed, which is
 * the point (P3.241): a list duplicated beside a single source of truth drifts
 * silently. `capabilities/instruction-files.ts` is now the only holder, and it
 * is a `node:fs`/`node:path` leaf precisely so this module can read it without
 * the collector's `gray-matter`/MCP closure following it into the Pi subprocess.
 */
import { isInstructionFileName as isInstructionFile } from '../capabilities/instruction-files.ts';

export type AgentTier = 'small' | 'medium' | 'big';
export type AgentToolset = 'read-only' | 'full';

/**
 * Which rung of `sub-agents.md#choose-the-subagent-scope` a definition came
 * from. The page's rule is one sentence — "When multiple subagents share the
 * same name, Claude Code uses the one from the higher-priority location." —
 * over a five-row table: Managed settings 1 (highest), `--agents` CLI flag 2,
 * `.claude/agents/` 3, `~/.claude/agents/` 4, plugin `agents/` 5 (lowest).
 *
 * This fork's names for those rungs, and the two facts a reader needs before
 * trusting the mapping (both measured 2026-09-08, P6.902):
 *
 *  - `workspace` is a rung the page does not have: `<workspaceRootPath>/config.json`
 *    `orchestratorAgents` plus `<workspaceRootPath>/*.md`, the host-owned
 *    workspace store (`ProjectHandleService`'s `managedRootPaths` — "Managed
 *    roots are never valid external projects"). It is NOT the page's managed
 *    settings rung, and this module's own docblocks called it that until P6.902.
 *    It sits between `project` and `user`, which is where insertion order has
 *    always put it.
 *  - `managed` and `session` are declared here and emitted by NO branch of
 *    {@link loadAgentDefinitions}. The managed rung is real in this fork, on the
 *    OTHER route: `<systemDir>/agents` at `managedScope = { kind: 'builtin' }`
 *    (`capabilities/native-sources.ts`, landed by P6.239), which reaches this
 *    module already resolved, as the closed-world `runtimeDefinitions` snapshot.
 *    `session` is the `--agents` flag, which P6.317 (2) has not landed.
 *
 * They are declared anyway so the ordering is a table a later rung can be
 * inserted into by NAME, rather than the accident of which loop runs last.
 */
export type AgentDefinitionScope =
  | 'managed'
  | 'session'
  | 'project'
  | 'workspace'
  | 'user'
  | 'plugin'
  | 'builtin';

/**
 * Highest priority first — the array INDEX is the rank, and nothing else in
 * this module encodes the order. {@link AgentDefinitionScope} says which rungs
 * have a source today and which are declared ahead of one.
 */
export const AGENT_DEFINITION_SCOPE_PRIORITY: readonly AgentDefinitionScope[] = Object.freeze([
  'managed',
  'session',
  'project',
  'workspace',
  'user',
  'plugin',
  'builtin',
]);

/**
 * An absent or unrecognized scope ranks LAST, so a definition carrying no
 * provenance can never displace one that does.
 */
function agentScopeRank(scope: AgentDefinitionScope | undefined): number {
  const index = scope ? AGENT_DEFINITION_SCOPE_PRIORITY.indexOf(scope) : -1;
  return index < 0 ? AGENT_DEFINITION_SCOPE_PRIORITY.length : index;
}

/**
 * STRICT: same-rung definitions do not outrank each other, so within one scope
 * the last one read still wins (the workspace markdown over the `config.json`
 * entry of the same name; a later file in one directory over an earlier one).
 * Only a strictly lower rung is refused.
 */
export function agentScopeOutranks(
  candidate: AgentDefinitionScope | undefined,
  incumbent: AgentDefinitionScope | undefined,
): boolean {
  return agentScopeRank(candidate) < agentScopeRank(incumbent);
}

/**
 * sub-agents.md, `color` row: "Display color for the subagent in the task list
 * and transcript. Accepts `red`, `blue`, `green`, `yellow`, `purple`, `orange`,
 * `pink`, or `cyan`." The list is closed — an unrecognized value is rejected
 * rather than dropped, so a typo surfaces at load instead of silently theming
 * the agent with the default.
 */
export type AgentColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan';
export const AGENT_COLORS: readonly AgentColor[] = Object.freeze([
  'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan',
]);
const AGENT_COLOR_SET = new Set<string>(AGENT_COLORS);

/**
 * sub-agents.md, `memory` row: "Persistent memory scope: `user`, `project`, or
 * `local`. Enables cross-session learning." The three scopes map to
 * `~/.claude/agent-memory/<name>/`, `.claude/agent-memory/<name>/` and
 * `.claude/agent-memory-local/<name>/` respectively; ours hang off this fork's
 * two namespaces instead — `<configDir>/agent-memory/<name>/`,
 * `<project>/.nessy-agent/agent-memory/<name>/` and
 * `<project>/.nessy-agent/agent-memory-local/<name>/`
 * (`agent/memory/agent-memory.ts:getAgentMemoryDirPath`).
 */
export type AgentMemoryScope = 'user' | 'project' | 'local';
const AGENT_MEMORY_SCOPES = new Set<string>(['user', 'project', 'local']);

/**
 * sub-agents.md, `isolation` row: "Set to `worktree` to run the subagent in a
 * temporary git worktree, giving it an isolated copy of the repository branched
 * by default from your default branch rather than the parent session's `HEAD`."
 *
 * `worktree` is the only documented value. The base-branch half of that
 * sentence: `worktreeBaseShaCandidates` resolves `origin/HEAD` first under the
 * shipped `baseRef: 'fresh'` default, REFRESHING it per worktrees.md:128 —
 * when the repository hasn't been fetched in the last 24 hours, the default
 * branch is fetched (capped at five seconds, cached ref on failure) — and
 * falling back to local HEAD only for a repository whose `origin/HEAD` can't
 * be read or fetched.
 */
export type AgentIsolation = 'worktree';

/**
 * P6.317 (2) — ONE entry of the `--agents` JSON, as the page defines it.
 *
 * `sub-agents.md:221`, fetched raw 2026-08-16 and quoted verbatim at
 * `agent/claude-runtime-agents.ts`: *"The `--agents` flag accepts JSON with a
 * `prompt` field plus these frontmatter fields: `description`, `tools`,
 * `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`,
 * `maxTurns`, `skills`, `initialPrompt`, `memory`, `effort`, `background`, and
 * `isolation`."* Fifteen names, and this interface is those fifteen and nothing
 * else — the flag is a documented surface, so a sixteenth field of our own would
 * be a divergence rather than an addition.
 *
 * Deliberately WIDE (`unknown`-ish scalars, `readonly unknown[]` lists). This is
 * caller JSON off a CLI flag, so it is untrusted input, and the one validator is
 * `materializePiRuntimeAgentDefinitions`' session-agent route — which reuses the
 * same field parsers the file route and the wire parse use, so a value that a
 * `.claude/agents/*.md` file would be refused for is refused here too, with the
 * same message. A narrower type here would only move the lie earlier: `JSON.parse`
 * returns `any` and a cast cannot check a field.
 *
 * `color` and `tier` are NOT in the page's list and are not accepted. `prompt`
 * is the agent's instructions — the markdown BODY on the file route — and it is
 * the only required field.
 *
 * The rung this scope occupies is {@link AgentDefinitionScope}'s `'session'`,
 * rank 2 of {@link AGENT_DEFINITION_SCOPE_PRIORITY} — above every disk location.
 */
export interface SessionAgentDefinitionV1 {
  /** The agent's instructions. The markdown body on the file route. */
  prompt?: unknown;
  description?: unknown;
  tools?: unknown;
  disallowedTools?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  /** Server NAMES, inline `.mcp.json`-shaped definitions, or a mix of both. */
  mcpServers?: unknown;
  /** A subagent frontmatter `hooks` block, already parsed out of JSON. */
  hooks?: unknown;
  maxTurns?: unknown;
  skills?: unknown;
  initialPrompt?: unknown;
  memory?: unknown;
  effort?: unknown;
  background?: unknown;
  isolation?: unknown;
}

export interface AgentDefinition {
  name: string;
  /**
   * Discriminator for the reserved `fork` type (sub-agents.md:1004). Present
   * only on `FORK_AGENT_DEFINITION`; a fork carries no prompt, toolset or model
   * of its own, so every spawn path must branch on this BEFORE reading them.
   */
  fork?: true;
  /**
   * Which rung of {@link AGENT_DEFINITION_SCOPE_PRIORITY} this definition came
   * from. Stamped by {@link loadAgentDefinitions}' filesystem branch and on its
   * built-in seeds; absent on a raw {@link readUserAgentDefinitions} record and
   * on a `runtimeDefinitions` snapshot entry, whose precedence was resolved
   * upstream by the capability resolver before it ever reached this module.
   */
  scope?: AgentDefinitionScope;
  /** Additional host-resolved names (for example a fully-qualified plugin capability key). */
  aliases?: string[];
  description: string;
  systemPrompt: string;
  toolset: AgentToolset;
  tools: string[];
  tier: AgentTier;
  model?: string;
  disallowedTools?: string[];
  /**
   * Present only when the author DECLARED a non-empty `tools` list and not one
   * entry survived resolution against this session's manifest. The spawner reads
   * it and refuses the launch (`errors.md#agent-would-be-spawned-with-zero-tools`
   * — "Every entry in the subagent's `tools` list failed to match a usable tool,
   * so Claude Code refused to launch the subagent: with no tools, it couldn't
   * act").
   *
   * It exists because the condition is invisible by the time a spawn happens:
   * the resolved `tools` above carries the always-available task tools, so an
   * agent whose every declared entry failed and an agent whose author wrote
   * `tools: []` arrive at the spawner with byte-identical pools. Measured, both
   * shapes reached `spawnChildSession` as
   * `["mcp__session__TaskCreate","mcp__session__ReportFindings"]`. Only the
   * builder that did the resolving can tell them apart, and the two must NOT be
   * treated alike: the same page says an authored-empty list "skips the refusal
   * and launches the subagent without tools" (P2.202's decision, still standing).
   *
   * Set by `buildPiRuntimeAgentDefinitions` from the manifest, and by
   * {@link reduceDeclaredSubagentToolEntry}'s pool-free half in this module's
   * own markdown/JSON loader (P3.232) — the two loaders that read the same agent
   * file, which used to answer this question differently. Absent on a builtin,
   * whose list is canonical by construction, so its absence still means
   * "no refusal".
   */
  zeroToolResolution?: {
    /** Declared entries that matched no tool in this session. */
    unmatched: readonly string[];
    /** Tools that resolved and were then withheld from every subagent. */
    withheld: readonly string[];
  };
  /**
   * Optional per-turn cap on how many times this agent's child session may run
   * (initial turn + each resume). Positive integer; absent means unbounded by
   * this field. Enforced host-side as an upper bound; it never widens an
   * inherited limit.
   */
  maxTurns?: number;
  /**
   * Optional requested permission mode for this agent's child session. The host
   * CLAMPS it to be no broader than the parent session's mode — a broader
   * request only ever narrows, never widens. Absent means "inherit the parent's
   * mode" (current behavior). Stored as an internal mode key.
   */
  permissionMode?: PermissionMode;
  effort?: ThinkingLevel;
  /**
   * Persistent memory scope for this agent (`user` / `project` / `local`).
   *
   * Consumed at spawn, host-side, in the child-session admission path: the
   * directory is created, the first 200 lines / 25 KB of its `MEMORY.md` are
   * appended to the child's system prompt, and `read`/`write`/`edit` are
   * granted — all three together or none, and all three inert when auto memory
   * is off (sub-agents.md:521-527, claude-directory.md's `agent-memory/` node).
   */
  memory?: AgentMemoryScope;
  /**
   * `true` forces this agent to run as a background task "even when Claude
   * needs its result right away" (sub-agents.md `background` row). Absent means
   * the host chooses, which is our existing depth-1 default.
   */
  background?: boolean;
  /** Display color in the task list and transcript. Presentation only. */
  color?: AgentColor;
  /**
   * sub-agents.md:297, the `initialPrompt` row: "Auto-submitted as the first
   * user turn when this agent runs as the main session agent (via `--agent` or
   * the `agent` setting). Commands and skills are processed. Prepended to any
   * user-provided prompt". `sub-agents.md:223` lists it among the fields the
   * `--agents` JSON flag accepts.
   *
   * Parsed, validated and carried — the same shape `memory` above has, and for
   * the same reason: the value is no longer discarded in silence, but nothing
   * submits it yet. The row's own precondition is a MAIN-SESSION-AGENT surface
   * (`--agent`, `--agents`, an `agent` setting) and this fork has none; R30c
   * costed exactly that surface as a deviation
   * (docs/superpowers/plans/2026-07-29-subagent-frontmatter.md).
   *
   * Deliberately NOT read on the subagent dispatch route: the row scopes itself
   * to "when this agent runs as the main session agent", so a subagent spawned
   * from this definition must ignore it. That is why the Pi subagent bridge
   * (`buildPiRuntimeAgentDefinitions`) does not forward it.
   */
  initialPrompt?: string;
  /**
   * `worktree` runs this agent in a temporary git worktree. It only ever
   * NARROWS: an agent that would otherwise share the live tree moves into an
   * isolated copy, never the reverse.
   */
  isolation?: AgentIsolation;
  /** Pinned capability identity. Present only on host-materialized definitions. */
  capabilityGeneration?: string;
  definitionKey?: string;
  definitionDigest?: string;
  /**
   * The source this definition loaded from (descriptor provenance,
   * `key@generation`). Present only on host-materialized definitions; the
   * `/context` subagent rows name it.
   */
  provenance?: string;
  skillKeys?: string[];
  mcpServerKeys?: string[];
  /**
   * P6.790 (P6.342 split a) — the INLINE half of `mcpServers`, keyed by server
   * name, beside {@link mcpServerKeys}, which stays the NAME-REFERENCE half.
   *
   * Two fields rather than one union, because the two are different things
   * downstream and the page treats them differently: a name reference resolves
   * against the session's own capability view and loads with no trust check,
   * while an inline definition is a server this file is asking to START and
   * loads *"only after you trust the folder the agent file came from"*
   * (`sub-agents.md`, the explicit `<span id="inline-server-trust" />` anchor).
   * Collapsing them would make that gate impossible to write, which is P6.792.
   *
   * PARSED, CARRIED AND VERDICTED — NOT YET FORWARDED AT SPAWN. This docblock
   * said *"the Pi transport descriptor … has no key for it"* until C3.142
   * (2026-09-11) and that half is spent: P6.791 `05cd7ef2d` added the descriptor
   * key and P6.816 `280ac9b1a` added the verdict beside it, so
   * `PiRuntimeAgentDefinitionDescriptor` now carries both `mcpServerInline` and
   * {@link mcpServerInlineTrusted} (`agent/pi-harness/runtime-agent-definition.ts`,
   * where `parseDefinitionEntry` refuses a map with no verdict and a verdict with
   * no map). The residue that survives is one step further down: NO SPAWN SITE
   * CONSUMES THE MAP. No file under `packages/pi-agent-server`,
   * `packages/server-core` or `packages/codex-agent-server` names the field at
   * all, and `agent/claude-runtime-agents.ts` still forwards the NAME-REFERENCE
   * half only — its own comment states why, and codex's `[agents.<role>]` has no
   * MCP field for the inline form to reach. The parse landed first so the value
   * stops being DESTROYED at read time (`- playwright:` became the bogus server
   * name `"playwright:"`, taking every later reference with it); adding a
   * descriptor key has a silent-total-loss failure mode of its own — see the
   * digest-position rule pinned in `agent/claude-runtime-agents.ts` — which is
   * why it was pinned by a test before the key existed.
   */
  mcpServerInline?: Record<string, Record<string, unknown>>;
  /**
   * P6.792 (P6.342 split c) — the folder-trust VERDICT for
   * {@link mcpServerInline}, carried instead of the PATH the gate would
   * otherwise have to re-derive. This definition has {@link provenance}, which
   * is `key@generation` — a generation stamp, not a folder — so the question
   * *"may these servers START?"* is unanswerable from what reaches a consumer
   * unless the answer travels with the map.
   *
   * `sub-agents.md`, the explicit `<span id="inline-server-trust" />` anchor:
   * *"Claude Code loads an inline server from an agent file in your project's
   * `.claude/agents/` directory, or in an `--add-dir` directory's
   * `.claude/agents/`, only after you [trust the folder the agent file came
   * from]."* The same section exempts a name reference, and an inline server
   * from `~/.claude/agents/`, from `--agents`/the SDK `agents` option, or from
   * managed settings — which is why {@link mcpServerKeys} needs no verdict and
   * this field is stamped for the user-level and workspace scopes.
   *
   * ABSENCE MEANS UNTRUSTED, and {@link loadAgentDefinitions} drops the map
   * rather than carrying it unverdicted. This fork's own filesystem loader is
   * STRICTER than the page — an untrusted project folder loses the whole
   * definition (`options.projectTrusted`), where the page keeps the agent and
   * skips only its inline servers — so on those three branches the stamp is
   * always `true`. The branch where absence is REACHABLE is
   * `options.runtimeDefinitions`, the host-supplied snapshot: a descriptor
   * built without consulting trust arrives with a map and no verdict, and
   * fail-closed is the only reading of that which is not a guess.
   *
   * The page's version note is worth keeping beside this: *"Before v2.1.238,
   * Claude Code loaded these servers without checking trust."* This docblock
   * added that the vendored bundle self-reported 2.1.233, i.e. BEHIND the
   * version that added the check — and C3.142 re-read it on 2026-09-11: after
   * the P7.1 lift BOTH self-reports say `2.1.247` (`claudeCodeVersion` in
   * `@anthropic-ai/claude-agent-sdk/package.json`, and `claude --version` from
   * the darwin-arm64 bundle), so the bundle is now PAST the version that added
   * the check and the direction has flipped: the gate below is no longer the
   * documentation leading the bundle, it is our own fail-closed reading of a
   * check the binary already performs. Re-read both self-reports rather than
   * grepping the binary for a dotted version, which counts build constants
   * (AGENTS.md §'docs are the contract for BEHAVIOUR, not for MEMBERSHIP').
   *
   * C3.324 (2026-09-12) then answered the question that flip raised — whether
   * two enforcers of one rule is still what we want. **The HOST gate is the
   * seam and the child's gate is not something it can be pinned to: the two
   * judge DISJOINT inputs on every runtime we ship.** On claude the inline map
   * is never forwarded (`agent/claude-runtime-agents.ts` sends the resolved
   * name-reference form, which the page exempts from the trust rule outright);
   * the child would refuse it anyway unless the remedy key is set — we ARE an SDK
   * session, the very case the same section's *"Trust that doesn't count"* bullet
   * names; the remedy being `projects["<path>"].hasTrustDialogAccepted`, which
   * the HOST writes for the MAIN child's folder trust since F1.789
   * (`agent/backend/claude/project-trust-entry.ts`; the 2026-09-12 writes-nowhere
   * reading is superseded); and on Pi and codex there is no second enforcer at all.
   * The reasoning and its readings live in ONE place, on `inlineServersTrusted` in
   * `agent/pi-harness/runtime-agent-definition.ts`.
   */
  mcpServerInlineTrusted?: true;
}

/** One skipped definition (markdown file or config.json entry), for the caller's diagnostics channel. */
export interface AgentDefinitionLoadFailure {
  /** The file carrying the skipped definition, as the user would open it. */
  file: string;
  reason: string;
}

export interface AgentDefinitionOptions {
  workspaceRootPath?: string;
  /** Path-free, host-materialized definitions captured in the active capability lease. */
  runtimeDefinitions?: readonly AgentDefinition[];
  /** Project working directory; `.nessy-agent/agents` is read from here when trusted. */
  projectRoot?: string;
  /**
   * Whether the project `projectRoot` is explicitly trusted (W6). Project
   * `.nessy-agent/agents` definitions are loaded only when true; defaults to
   * untrusted (fail-closed).
   */
  projectTrusted?: boolean;
  /**
   * A2/A3: a malformed definition — a markdown file, a config.json
   * `orchestratorAgents` entry, or an unparseable config.json itself — is
   * SKIPPED, never directory- or list-fatal: the same per-entry contract the
   * capability materializer follows (A1, sub-agents.md: a malformed subagent
   * definition is that agent's problem, not the session's). This callback
   * names the file and the reason; without it the skip is still traced via
   * debug(). The global agents directory is additionally covered by
   * `nessy-general-agent doctor`; config.json is workspace-scoped, which the
   * session-free doctor cannot resolve.
   */
  onInvalidDefinition?: (failure: AgentDefinitionLoadFailure) => void;
}

const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];
const FULL_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
const TIERS = new Set<AgentTier>(['small', 'medium', 'big']);
const TOOLSETS = new Set<AgentToolset>(['read-only', 'full']);

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    name: 'scout',
    description: 'Inspect the workspace and return concise facts with file references.',
    systemPrompt: 'You are a scout agent. Read only what is needed, cite concrete files or commands, and avoid edits or speculative plans.',
    toolset: 'read-only',
    tools: READ_ONLY_TOOLS,
    tier: 'small',
  },
  {
    name: 'planner',
    description: 'Break a task into ordered implementation steps and risks.',
    systemPrompt: 'You are a planner agent. Produce a short executable plan grounded in the current repository state. Do not edit files.',
    toolset: 'read-only',
    tools: READ_ONLY_TOOLS,
    tier: 'medium',
  },
  {
    name: 'worker',
    description: 'Implement a scoped change in the current workspace.',
    systemPrompt: 'You are a worker agent. Make the smallest correct change, follow existing project patterns, and report the files and checks touched.',
    toolset: 'full',
    tools: FULL_TOOLS,
    tier: 'big',
  },
  {
    name: 'reviewer',
    description: 'Review changes for bugs, regressions, and missing verification.',
    systemPrompt: 'You are a reviewer agent. Focus on defects and test gaps. Return findings first, with file references, and avoid rewriting code.',
    toolset: 'read-only',
    tools: READ_ONLY_TOOLS,
    tier: 'medium',
  },
];

/**
 * sub-agents.md:1010 — "Claude can spawn a fork by requesting the `fork`
 * subagent type explicitly."
 *
 * `fork` is a RESERVED name, not a fifth entry in `BUILTIN_AGENT_DEFINITIONS`.
 * A fork has no system prompt, no toolset and no model of its own: :1004 and the
 * :1038 table say all three come from the main session ("Same as main session").
 * Adding it as an ordinary definition would give it placeholder values that some
 * reader would eventually pick up, and `loadAgentDefinitions` would let a
 * workspace or project markdown file overwrite it by name.
 */
export const FORK_AGENT_NAME = 'fork';

/**
 * The marker returned for `agent: 'fork'`. It carries the name and the `fork`
 * discriminator and NOTHING a spawn path could mistake for policy: reading
 * `systemPrompt`, `tools` or `model` throws instead of yielding a placeholder,
 * so a code path that forgets the fork branch fails loudly at the point of the
 * mistake rather than silently spawning a promptless, tool-less child.
 */
export const FORK_AGENT_DEFINITION: AgentDefinition = Object.freeze({
  name: FORK_AGENT_NAME,
  fork: true,
  description: 'Fork the current conversation: a subagent that inherits the full message history, system prompt, tools and model of this session.',
  get systemPrompt(): string {
    throw new Error('fork-definition-has-no-system-prompt: a fork inherits the parent session prompt');
  },
  get tools(): string[] {
    throw new Error('fork-definition-has-no-tools: a fork inherits the parent session tool pool');
  },
  get model(): string {
    throw new Error('fork-definition-has-no-model: a fork inherits the parent session model');
  },
  toolset: 'full',
  tier: 'medium',
} as AgentDefinition);

export function isForkAgentName(name: string): boolean {
  return normalizeName(name) === FORK_AGENT_NAME;
}

export function isForkAgentDefinition(definition: Pick<AgentDefinition, 'fork'>): boolean {
  return definition.fork === true;
}

export const BUILTIN_AGENT_NAMES: readonly string[] = Object.freeze(
  BUILTIN_AGENT_DEFINITIONS.map(definition => definition.name),
);
/**
 * Names a user, workspace, project or plugin definition can never claim. The
 * built-ins plus `fork`: R30c showed a plugin-supplied agent file is hostile
 * input, and a file named `fork` that could shadow the reserved type would let
 * a plugin substitute its own prompt, tools and permission mode for "inherit
 * the parent session".
 */
const BUILTIN_AGENT_NAME_SET = new Set([...BUILTIN_AGENT_NAMES, FORK_AGENT_NAME]);

interface UserAgentDefinition {
  name?: unknown;
  description?: unknown;
  systemPrompt?: unknown;
  toolset?: unknown;
  tools?: unknown;
  tier?: unknown;
  model?: unknown;
  disallowedTools?: unknown;
  maxTurns?: unknown;
  permissionMode?: unknown;
  effort?: unknown;
  memory?: unknown;
  background?: unknown;
  color?: unknown;
  initialPrompt?: unknown;
  skills?: unknown;
  isolation?: unknown;
  mcpServers?: unknown;
}

/**
 * Frontmatter keys whose value is a LIST. A key missing from this set arrives as
 * a single string (`"a, b"` stays one value), so every new array-shaped field
 * has to be added here as well as to the definition.
 *
 * `initialPrompt` is a SCALAR and must stay out: listing it would split a prompt
 * containing a comma into a list and lose everything after the first clause.
 */
const ARRAY_FRONTMATTER_KEYS = new Set(['tools', 'disallowedTools', 'skills', 'mcpServers']);

/**
 * P6.790 (P6.342 split a) — the list keys whose entries may ALSO be an INLINE
 * MAPPING, not only a string.
 *
 * `sub-agents.md#scope-mcp-servers-to-a-subagent`: *"Each entry in the list is
 * either an inline server definition or a string referencing an MCP server
 * already configured in your session"*, and its example is a YAML list mixing
 * the two:
 *
 * ```
 * mcpServers:
 *   - playwright:
 *       type: stdio
 *       command: npx
 *   - github
 * ```
 *
 * MEASURED AT HEAD, and worse than "the inline form dies at parse": the block
 * reader below collected `- playwright:` as the string `"playwright:"` and then
 * STOPPED, because the next line does not start with `- `. So the definition
 * loaded with `mcpServerKeys: ["playwright:"]` — a server name that resolves to
 * nothing — and the `- github` reference AFTER the inline entry was dropped
 * silently, with no diagnostic. The reference form the row records as working is
 * lost by the mere presence of an inline sibling; the indented lines then fell
 * through to the top-level key regex and became frontmatter keys of their own.
 *
 * Scoped to a NAMED SET rather than applied to every list: `tools` and
 * `disallowedTools` entries are grant strings that legitimately contain colons
 * and must keep their exact current behaviour.
 */
const INLINE_MAPPING_LIST_KEYS = new Set(['mcpServers']);

/**
 * Cap on a carried `initialPrompt`. Generous enough that no realistic authored
 * first turn hits it, small enough that a malformed file cannot carry an
 * unbounded string across the host->Pi descriptor.
 */
export const MAX_AGENT_INITIAL_PROMPT_LENGTH = 16 * 1024;

/**
 * A bare YAML block-scalar indicator (`|`, `>`, and their chomping/indentation
 * variants `|-`, `>+`, `|2`).
 *
 * Neither frontmatter reader in this repo supports block scalars: `initialPrompt: |`
 * matches the ordinary scalar regex in `parseFrontmatter` below — and the
 * identical one in `splitMarkdownFrontmatter` — and arrives as the literal
 * string "|". Carrying that would hand a future main-session turn the indicator
 * instead of the prompt.
 */
export function isYamlBlockScalarIndicator(value: string): boolean {
  return /^[|>][-+]?\d*$/.test(value.trim());
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * whats-new/2026-w20.md:91 — "Agent tool `subagent_type` now matches case- and
 * separator-insensitively, so `"Code Reviewer"` resolves to `code-reviewer`".
 *
 * Case folding alone does not satisfy that sentence: the page's own example
 * differs by a SEPARATOR, not by case. This is the fold `parsePermissionMode`
 * already applies for the same documented reason (agent/mode-types.ts), widened
 * from `[-_ ]` to `\s` so a tab folds too.
 *
 * COMPARISON ONLY. It must never replace `normalizeName` on the storage side:
 * the normalized `name` is a `Map` key in `loadAgentDefinitions` and travels the
 * host->Pi descriptor, so folding it there would collapse `code-reviewer` and
 * `code_reviewer` into one entry (last writer wins) and move a wire value.
 */
export function foldAgentName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_\s]+/g, '');
}

/** `Tool(specifier)` — a parametrized grant as a `tools` list may carry it. */
export const PARAMETRIZED_TOOL_SHAPE = /^([A-Za-z][A-Za-z0-9_-]*)\s*\(.*\)$/s;

/**
 * The spellings of Claude's subagent tool — the ONE tool whose parametrized
 * form is documented inside a `tools` list, and therefore the only one whose
 * parentheses either side of the boundary may strip.
 *
 * sub-agents.md § *Restrict which subagents can be spawned*: "The
 * `Agent(agent_type)` allowlist syntax applies only to an agent running as the
 * main thread with `claude --agent`. In a subagent definition, listing `Agent`
 * in `tools` lets that subagent spawn subagents of its own while the depth
 * limit allows it, but any type list inside the parentheses is ignored."
 *
 * Both loaders and both sides of the Pi boundary read this list. `resolveExplicitTools`
 * (`pi-agent-server/.../runtime-agent-definitions.ts`) turns `Agent(a, b)` into
 * the subagent tool a child arrives holding; the host re-validates that arrival
 * against THIS normalization of the author-declared list
 * (`SessionManager.ts`, `runtime-agent-tool-unavailable:<tool>`) and derives
 * `worktreePolicy` from it too. Strip on one side only and the child is granted
 * a tool the host then refuses — which is why the rule lives here, once.
 *
 * Deliberately narrow. Reading `Bash(git diff:*)` as bare `bash` would widen a
 * grant past what its author wrote and past what the docs give the form.
 */
export const SUBAGENT_TOOL_SPELLINGS: ReadonlySet<string> = new Set(['agent', 'task', 'subagent']);

/**
 * Tools that never reach a subagent, inherited OR explicitly requested.
 * `agent-sdk/user-input.md`: AskUserQuestion "is not currently available in
 * subagents spawned via the Agent tool" — our `ask_user` follows.
 *
 * P3.232 moved this here from `pi-agent-server/.../runtime-agent-definitions.ts`.
 * TWO loaders read the same agent file — the capability route
 * (`buildPiRuntimeAgentDescriptor` → `buildPiRuntimeAgentDefinitions`) and the
 * markdown/JSON fallback loader in THIS module — and only the first one had this
 * set. A rule that lives in one of two loaders is not a rule; it is a
 * coincidence that holds until the other loader is used.
 */
export const SUBAGENT_UNAVAILABLE_TOOLS: ReadonlySet<string> = new Set(['ask_user']);

/**
 * P3.232 — the POOL-FREE half of the declared-`tools` rule, in ONE place,
 * because two loaders read the same agent file and only one of them has a
 * session manifest.
 *
 * The question "what does this declared entry grant?" splits cleanly in two:
 *
 * - **Decidable without a session** — the parametrized shape. Outside
 *   `Agent(...)`, no doc gives `Tool(specifier)` a meaning in a subagent `tools`
 *   list, and reducing one to its bare tool would GRANT authority the author did
 *   not write (`Bash(git diff:*)` becoming `bash`). So it is denied by omission.
 *   Inside `Agent(...)` the reduction IS the documented reading —
 *   {@link SUBAGENT_TOOL_SPELLINGS} carries the sentence — and the shredded
 *   literal it replaces is a measured live defect (the `claude-security`
 *   plugin's `Agent(scan-inventory, scan-researcher)`).
 * - **Not decidable without a session** — whether the reduced name matches a
 *   tool at all, whether a `mcp__<server>__*` pattern expands to anything, and
 *   the depth-limit `subagent` withhold. Those stay with the caller that holds a
 *   manifest; a caller without one gets the decidable answers and invents
 *   nothing. That residue is why this function returns a NAME rather than a
 *   verdict.
 *
 * `advertisedVerbatim` is the capability route's precedence rule, kept here so
 * the two callers cannot drift on it: a name the manifest advertises exactly as
 * written is never re-read as parametrized. A pool-free caller passes `false`,
 * which is the honest answer when there is no manifest to ask.
 */
export function reduceDeclaredSubagentToolEntry(
  entry: string,
  advertisedVerbatim = false,
): { name: string } | { denied: 'parametrized-specifier' } {
  const name = entry.trim();
  const parametrized = advertisedVerbatim ? null : PARAMETRIZED_TOOL_SHAPE.exec(name);
  if (parametrized && !SUBAGENT_TOOL_SPELLINGS.has(parametrized[1]!.toLowerCase())) {
    return { denied: 'parametrized-specifier' };
  }
  return { name: parametrized ? parametrized[1]! : name };
}


/**
 * The pool-free resolution this module's loader can honestly perform on an
 * author-declared `tools` list, expressed in the same three buckets
 * `resolveExplicitTools` reports (`pi-agent-server/.../runtime-agent-definitions.ts`)
 * so the zero-tools verdict means the same thing whichever loader produced it.
 *
 * `unmatched` is `errors.md`'s first group and `withheld` its second; the third —
 * `Agent` at the depth limit — is depth-scoped and belongs to the spawner's own
 * budget, which this session-free loader has no access to. A list that resolves
 * only to withheld tools is therefore still distinguishable from one that
 * resolved to nothing at all, which is the distinction the refusal is written on.
 */
function resolveDeclaredToolsWithoutManifest(requested: readonly string[]): {
  tools: string[];
  unmatched: string[];
  withheld: string[];
} {
  const unmatched: string[] = [];
  const withheld: string[] = [];
  const tools: string[] = [];
  for (const entry of requested) {
    const reduced = reduceDeclaredSubagentToolEntry(entry);
    if ('denied' in reduced) {
      unmatched.push(entry);
      continue;
    }
    if (SUBAGENT_UNAVAILABLE_TOOLS.has(reduced.name.toLowerCase())) {
      withheld.push(reduced.name);
      continue;
    }
    tools.push(reduced.name);
  }
  return { tools: [...new Set(tools)], unmatched, withheld };
}

function toolsForToolset(toolset: AgentToolset): string[] {
  return toolset === 'full' ? [...FULL_TOOLS] : [...READ_ONLY_TOOLS];
}

function normalizeModel(model: unknown, label: string): string | undefined {
  if (model === undefined) return undefined;
  if (typeof model !== 'string') throw new Error(`Invalid ${label}: expected non-empty string`);
  const trimmed = model.trim();
  if (!trimmed) throw new Error(`Invalid ${label}: expected non-empty string`);
  return trimmed;
}

/**
 * Did the author WRITE this list key and hand it nothing?
 *
 * P2.185's general rule, at the layer that is the last to be able to see it: an
 * authored-but-empty list is a VALUE — the empty set — and an absent key is not
 * a value at all. Everywhere this pair has been collapsed in this codebase the
 * collapse meant MORE, so the two spellings have to stay apart here even when a
 * given reader ends up mapping them to the same output.
 *
 * The two shapes an empty list arrives in: `''`, which is how `parseFrontmatter`
 * delivers a present-but-empty key (`tools:` with no items beneath it), and a
 * genuinely empty array, which is what `tools: []`, `tools: ,,,` and `tools: ""`
 * all tokenize to. `undefined` — the key never appeared — is the only absent
 * one.
 */
function isAuthoredEmptyList(value: unknown): boolean {
  return value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * sub-agents.md, the `tools` frontmatter row (fetched 2026-08-26, when it sits
 * at :290 rather than the :279 this comment used to name): "[Tools](#available-tools)
 * the subagent can use. Inherits every tool available to subagents if
 * omitted. If no entry in the list resolves to a tool, the subagent usually
 * [fails to launch](/docs/en/errors#agent-would-be-spawned-with-zero-tools)
 * with an error naming the entries."
 *
 * This function answers only "which entries did the author name", and returns
 * `undefined` for both an omitted key and an empty one — it cannot tell them
 * apart, and does not try. {@link isAuthoredEmptyList} is the distinction, and
 * each caller applies it to its OWN field: for `disallowedTools`, `skills` and
 * `mcpServers` the empty set and the absent key produce the same thing (an
 * empty denylist denies nothing, an empty preload list preloads nothing), so
 * they read this return value alone. `tools` is the field where the two answers
 * differ, and its call site says how. A present list with a malformed ENTRY
 * still throws — the caller skips that one definition, per A2.
 */
function normalizeExplicitStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === '') return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected a string list`);
  }
  if (value.length === 0) return undefined;
  const values = value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Invalid ${label}[${index}]: expected non-empty string`);
    }
    return item.trim();
  });
  return [...new Set(values)];
}

/**
 * P6.790 — `mcpServers`, the one list key whose entries are two different
 * things, split into the two fields that carry them.
 *
 * `normalizeExplicitStringList` THREW `expected non-empty string` on the first
 * inline entry, which on the `config.json` path took the entire agent definition
 * out of the session (measured at HEAD: `Invalid orchestratorAgents[0]
 * .mcpServers[0]: expected non-empty string`, definition skipped) — an author
 * following the documented example lost the agent, not just its servers.
 *
 * A malformed entry is still refused BY NAME, because the alternative is an
 * agent that quietly runs without the server it was written around. What is no
 * longer refused is the shape the page documents.
 *
 * The non-array message is left verbatim: it is the answer for
 * `mcpServers: "github"`, which is a scalar and not the documented list.
 */
function normalizeMcpServerList(value: unknown, label: string): {
  keys: string[] | undefined;
  inline: Record<string, Record<string, unknown>> | undefined;
} {
  if (value === undefined || value === '') return { keys: undefined, inline: undefined };
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected a string list`);
  }
  const keys: string[] = [];
  const inline: Record<string, Record<string, unknown>> = {};
  value.forEach((item, index) => {
    if (typeof item === 'string') {
      if (!item.trim()) throw new Error(`Invalid ${label}[${index}]: expected non-empty string`);
      keys.push(item.trim());
      return;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(
        `Invalid ${label}[${index}]: expected a server name or an inline server definition`,
      );
    }
    // "Inline definitions use the same schema as `.mcp.json` server entries,
    // keyed by the server name" — so every own key of the entry names a server.
    // An entry with no key at all is refused rather than ignored: it is an
    // author asking for a server and getting none.
    const names = Object.keys(item as Record<string, unknown>);
    if (names.length === 0) {
      throw new Error(`Invalid ${label}[${index}]: inline server definition names no server`);
    }
    for (const name of names) {
      const config = (item as Record<string, unknown>)[name];
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`Invalid ${label}[${index}].${name}: expected an inline server definition`);
      }
      inline[name] = config as Record<string, unknown>;
    }
  });
  return {
    keys: keys.length > 0 ? [...new Set(keys)] : undefined,
    inline: Object.keys(inline).length > 0 ? inline : undefined,
  };
}

/**
 * `maxTurns` must be a positive integer. Frontmatter delivers it as a string
 * (`maxTurns: "5"`); JSON config delivers a native number. Anything else
 * (zero, negative, non-integer, non-numeric) is invalid. Callers reject an
 * explicitly malformed cap so it can never silently become unbounded.
 */
function normalizeMaxTurns(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 1) return undefined;
  return numeric;
}

/**
 * `permissionMode` is validated against the canonical mode set (and legacy
 * aliases) via `parsePermissionMode`. Callers reject an explicitly malformed
 * mode so it can never silently inherit a broader parent mode.
 */
function normalizePermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return parsePermissionMode(value) ?? undefined;
}

/**
 * `background` is a boolean in JSON config and the string `"true"` / `"false"`
 * in markdown frontmatter, which is the shape difference `maxTurns` already
 * documents. Anything outside that set is malformed rather than falsy, so it is
 * rejected by the caller instead of quietly meaning "let the host choose".
 */
function normalizeBackground(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function normalizeMemoryScope(value: unknown): AgentMemoryScope | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return AGENT_MEMORY_SCOPES.has(normalized) ? normalized as AgentMemoryScope : undefined;
}

function normalizeIsolation(value: unknown): AgentIsolation | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().toLowerCase() === 'worktree' ? 'worktree' : undefined;
}

function normalizeColor(value: unknown): AgentColor | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return AGENT_COLOR_SET.has(normalized) ? normalized as AgentColor : undefined;
}

/**
 * `initialPrompt` is a free-text scalar, so the only malformed shapes are a
 * non-string, an over-length value, and a block scalar this parser cannot read.
 *
 * The block-scalar case is OMITTED rather than rejected, unlike `color` or
 * `isolation`: those are representable values that are wrong, while `|` is our
 * flat parser's limit and not the author's error. Rejecting would make an
 * imported Claude agent disappear from the session over a field nothing
 * consumes yet — strictly worse than today, where the key is merely dropped.
 */
function normalizeInitialPrompt(value: unknown, label: string): string | undefined {
  // `''` is what `parseFrontmatter` delivers for a present-but-empty key
  // (`initialPrompt:` with nothing after it), the same present-but-empty shape
  // `normalizeExplicitStringList` already reads as omitted.
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid ${label}: expected non-empty string`);
  const trimmed = value.trim();
  if (!trimmed || isYamlBlockScalarIndicator(trimmed)) return undefined;
  if (trimmed.length > MAX_AGENT_INITIAL_PROMPT_LENGTH) {
    throw new Error(`Invalid ${label}: exceeds ${MAX_AGENT_INITIAL_PROMPT_LENGTH} characters`);
  }
  return trimmed;
}

function normalizeUserAgentDefinition(entry: UserAgentDefinition, label: string): AgentDefinition {
  if (typeof entry.name !== 'string' || !entry.name.trim()) {
    throw new Error(`Invalid ${label}: name must be a non-empty string`);
  }
  if (typeof entry.systemPrompt !== 'string' || !entry.systemPrompt.trim()) {
    throw new Error(`Invalid ${label}: systemPrompt must be a non-empty string`);
  }

  if (entry.tier !== undefined && (typeof entry.tier !== 'string' || !TIERS.has(entry.tier as AgentTier))) {
    throw new Error(`Invalid ${label}.tier`);
  }
  if (entry.toolset !== undefined && (typeof entry.toolset !== 'string' || !TOOLSETS.has(entry.toolset as AgentToolset))) {
    throw new Error(`Invalid ${label}.toolset`);
  }
  const tier = (entry.tier as AgentTier | undefined) ?? 'medium';
  const toolset = (entry.toolset as AgentToolset | undefined) ?? 'read-only';
  // P2.168, decided against the pages rather than against the old inference.
  // The A1 reading that stood here — "an empty list has no entries and restricts
  // nothing, so it parses as OMITTED" — is refuted by the very page
  // `sub-agents.md` links to for this behaviour. errors.md § *Agent would be
  // spawned with zero tools*, fetched 2026-08-26: "Omitting the `tools` field
  // never triggers this refusal. If you leave the `tools` list empty, or
  // `disallowedTools` removes every entry in it, Claude Code also skips the
  // refusal and launches the subagent WITHOUT TOOLS." The same section's fix
  // list states the other half from the author's side: "Delete the `tools` field
  // instead of listing tools to give the subagent every tool available to
  // subagents." Deleted means everything; empty means nothing.
  //
  // So the toolset default belongs to the OMITTED key alone. It was reachable
  // from `tools: ,,,` / `tools: ""` / `tools: []` / a bare `tools:`, and on
  // `toolset: full` that handed a fumbled list `bash`, `edit` and `write` —
  // three tools its author's own frontmatter asked for none of. `53007d740`'s
  // invariant, restated for this field: truncation must never widen.
  //
  // `claude-runtime-agents.ts` already reached this conclusion from the same
  // sentence for the skill-emptied case ("AN EMPTIED GRANT IS NOT A REFUSAL"),
  // so an empty grant is NOT rejected here either — the definition loads, with
  // an empty pool.
  const declaredTools = normalizeExplicitStringList(entry.tools, `${label}.tools`);
  // P3.232 — THE SAME RULE THE OTHER LOADER APPLIES. `~/.nessy-agent/agents/x.md`
  // is read twice in this fork: once by the capability route
  // (`buildPiRuntimeAgentDescriptor` → `buildPiRuntimeAgentDefinitions`), which
  // resolves every declared entry against the session manifest, and once here,
  // which took the list verbatim. Measured on one file with `tools: Grpe, Reed`:
  // the capability route dropped both entries, named them on the debug channel
  // and recorded the zero-tools verdict; this loader produced
  // `tools: ["Grpe","Reed"]` — a ceiling of two names no tool answers to, with
  // nothing said.
  //
  // Only the POOL-FREE half is decidable here, and inventing the other half is
  // what the shared helper's docblock refuses to do. So this closes the shape
  // rules — the `Tool(specifier)` denial and the `Agent(...)` reduction, which
  // is where a real plugin's `Agent(scan-inventory, scan-researcher)` was
  // silently shredded — plus the withhold set, and it records the verdict when
  // they empty a list the author wrote. Whether a surviving NAME matches a tool
  // in a given session stays with the loader that holds a manifest; a name this
  // loader keeps is narrower than what the capability route would grant it,
  // never wider.
  const resolvedDeclared = declaredTools ? resolveDeclaredToolsWithoutManifest(declaredTools) : undefined;
  const tools = resolvedDeclared
    ? resolvedDeclared.tools
    : (isAuthoredEmptyList(entry.tools) ? [] : toolsForToolset(toolset));
  // P2.202 stands, and it is structural rather than re-asserted here:
  // `normalizeExplicitStringList` already returns `undefined` for BOTH an
  // omitted key and an authored-empty one, so `resolvedDeclared` exists only
  // when the author wrote at least one entry. An omitted list inherits, an
  // authored-empty one launches tool-less, and neither can reach this verdict.
  const zeroToolResolution = resolvedDeclared && resolvedDeclared.tools.length === 0
    ? { unmatched: resolvedDeclared.unmatched, withheld: resolvedDeclared.withheld }
    : undefined;
  const disallowedTools = normalizeExplicitStringList(entry.disallowedTools, `${label}.disallowedTools`);
  const maxTurns = normalizeMaxTurns(entry.maxTurns);
  const permissionMode = normalizePermissionMode(entry.permissionMode);
  const effort = normalizeThinkingLevel(entry.effort);
  // `skills` names skills to PRELOAD, and the loaded definition carries them as
  // `skillKeys`. The host resolves each name against the live capability view
  // and injects the full skill body — not the description — into the child's
  // context at startup; this path only carries the request.
  const skillKeys = normalizeExplicitStringList(entry.skills, `${label}.skills`);
  // `sub-agents.md#scope-mcp-servers-to-a-subagent`: "Each entry in the list is
  // either an inline server definition or a string referencing an MCP server
  // already configured in your session". P6.790 — BOTH forms are read now; the
  // list is split into the two fields rather than rejected at its first inline
  // entry, which used to take the whole definition out of the session on the
  // config.json path and silently corrupt it on the markdown one.
  const { keys: mcpServerKeys, inline: mcpServerInline } =
    normalizeMcpServerList(entry.mcpServers, `${label}.mcpServers`);
  const memory = normalizeMemoryScope(entry.memory);
  const background = normalizeBackground(entry.background);
  const color = normalizeColor(entry.color);
  const initialPrompt = normalizeInitialPrompt(entry.initialPrompt, `${label}.initialPrompt`);
  const isolation = normalizeIsolation(entry.isolation);
  if (entry.maxTurns !== undefined && maxTurns === undefined) {
    throw new Error(`Invalid ${label}.maxTurns: expected positive integer`);
  }
  if (entry.permissionMode !== undefined && permissionMode === undefined) {
    throw new Error(`Invalid ${label}.permissionMode`);
  }
  if (entry.effort !== undefined && effort === undefined) {
    throw new Error(`Invalid ${label}.effort`);
  }
  if (entry.memory !== undefined && memory === undefined) {
    throw new Error(`Invalid ${label}.memory: expected user, project or local`);
  }
  if (entry.background !== undefined && background === undefined) {
    throw new Error(`Invalid ${label}.background: expected true or false`);
  }
  if (entry.color !== undefined && color === undefined) {
    throw new Error(`Invalid ${label}.color: expected one of ${AGENT_COLORS.join(', ')}`);
  }
  if (entry.isolation !== undefined && isolation === undefined) {
    throw new Error(`Invalid ${label}.isolation: expected worktree`);
  }

  return {
    name: normalizeName(entry.name),
    description: typeof entry.description === 'string' && entry.description.trim()
      ? entry.description
      : `Workspace-defined ${entry.name} agent.`,
    systemPrompt: entry.systemPrompt,
    toolset,
    tools,
    ...(zeroToolResolution ? { zeroToolResolution } : {}),
    tier,
    model: normalizeModel(entry.model, `${label}.model`),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(effort === undefined ? {} : { effort }),
    ...(memory === undefined ? {} : { memory }),
    ...(background === undefined ? {} : { background }),
    ...(color === undefined ? {} : { color }),
    ...(initialPrompt === undefined ? {} : { initialPrompt }),
    ...(isolation === undefined ? {} : { isolation }),
    ...(skillKeys === undefined ? {} : { skillKeys }),
    ...(mcpServerKeys === undefined ? {} : { mcpServerKeys }),
    ...(mcpServerInline === undefined ? {} : { mcpServerInline }),
  };
}

function stripFrontmatterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatterValue(key: string, value: string): unknown {
  const stripped = stripFrontmatterQuotes(value);
  if (!ARRAY_FRONTMATTER_KEYS.has(key)) return stripped;

  if (stripped.startsWith('[')) {
    try {
      const parsed = JSON.parse(stripped);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // `splitToolGrantList`, the one tokenizer, and this was the SIXTH and last copy
  // of the bare comma split — the one a USER's own `agents/*.md` goes through,
  // with no plugin involved. `Agent(scan-inventory, scan-researcher)` shredded
  // into `Agent(scan-inventory` + `scan-researcher)`, neither of which resolves
  // to a tool: on `tools` the author silently loses the grant the agent was
  // written around, and on `disallowedTools` — the same key set — the denial
  // silently stops denying, which is a permission hole rather than a lost grant.
  //
  // The other two shapes of this key never reached here and were already safe: a
  // `[`-prefixed flow sequence returns above, and a `- ` block list is collected
  // per item by `parseFrontmatter` without calling this function at all. Both are
  // pinned by their own test arms.
  //
  // `skills` and `mcpServers` share the key set and ride along deliberately. They
  // carry names, never parenthesized specifiers, so paren-awareness is inert for
  // them; whitespace-as-delimiter only splits a value that could never have
  // resolved as one name anyway.
  return splitToolGrantList(stripped);
}

/**
 * P6.648 · THIS IS NOT A YAML PARSER, and one shape it accepts a real parser
 * rejects.
 *
 * It is line-based: `^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$` per line, plus a `- `
 * block list. A file whose frontmatter a YAML parser refuses can still "parse"
 * here — the reference shape is an UNTERMINATED QUOTED SCALAR
 * (`description: "reviews the diff`), which YAML rejects at end of stream and
 * which this reader takes as the whole rest of the line, quote and all.
 *
 * `plugin-marketplaces.md` § Read the validation results names the error we
 * therefore never emit, verbatim: *"`YAML frontmatter failed to parse: ...`:
 * fix the YAML in the frontmatter block of the skill, agent, or command file.
 * Until you do, a session reads no frontmatter fields from the file"*. That
 * string has no subject here, and the sentence's second half is the reason this
 * is RECORDED rather than fixed: upstream, a failed parse means the session
 * reads NO fields; here it reads the fields this reader found.
 *
 * **The property that matters holds, and it is the one worth keeping.**
 * `validateMarkdownAgentDefinitionContent` — what `plugin validate` runs — calls
 * `parseMarkdownAgentDefinition`, which calls THIS function. So validate and the
 * session cannot disagree about any file: whatever one accepts, the other loads
 * identically. Dropping a real YAML parser in would change what sessions load,
 * which is a contract change and not a repair (controller decision, size S:
 * record, do not build a parser).
 *
 * If that ever changes, change it in ONE place. Two readers is the failure mode
 * this comment exists to prevent: a validator stricter than the loader reports
 * problems in files that work, and a validator looser than the loader passes
 * files that will not load.
 */
/**
 * One inline server definition's body: an indentation-keyed mapping.
 *
 * DELIBERATELY NARROW, and the residue is stated rather than hidden. This reads
 * `key: scalar`, `key: <JSON flow value>` and `key:` opening a nested mapping —
 * which covers every field of the documented `.mcp.json` server schema the page
 * points at (`type`, `command`, `args`, `url`, `headers`, `env`). It does NOT
 * read a nested BLOCK SEQUENCE (`args:` followed by `- -y` lines), because
 * neither frontmatter reader in this repo reads one anywhere else either, and
 * the page's own example writes `args` as a JSON flow sequence. An author who
 * uses the block form gets `''` for that key rather than a wrong value, which is
 * the failure a caller can see.
 *
 * A value that fails to parse as JSON falls back to the scalar rather than
 * throwing: the alternative is one malformed line taking the whole agent
 * definition out of the session.
 */
function parseIndentedMapping(lines: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let base = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (!line.trim()) continue;
    base = Math.min(base, line.length - line.trimStart().length);
  }
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent !== base) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    if (!key) continue;
    const value = (match[2] ?? '').trim();
    if (value) {
      out[key] = value.startsWith('[') || value.startsWith('{')
        ? parseFlowValueOrScalar(value)
        : stripFrontmatterQuotes(value);
      continue;
    }
    const child: string[] = [];
    while (i + 1 < lines.length) {
      const nextLine = lines[i + 1] ?? '';
      if (nextLine.trim() && nextLine.length - nextLine.trimStart().length <= indent) break;
      child.push(nextLine);
      i += 1;
    }
    out[key] = child.length > 0 ? parseIndentedMapping(child) : '';
  }
  return out;
}

function parseFlowValueOrScalar(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return stripFrontmatterQuotes(value);
  }
}

function parseFrontmatter(frontmatter: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = frontmatter.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    if (!key) continue;
    const value = match[2] ?? '';
    if (value.trim()) {
      data[key] = parseFrontmatterValue(key, value);
      continue;
    }

    const list: unknown[] = [];
    const allowsInlineMapping = INLINE_MAPPING_LIST_KEYS.has(key);
    while (i + 1 < lines.length) {
      // The RAW line, not the trimmed one: indentation is what separates an
      // inline definition's body from the next list item, and `parseFrontmatter`
      // trims everything else away.
      const raw = lines[i + 1] ?? '';
      const next = raw.trim();
      if (!next.startsWith('- ')) break;
      i += 1;
      const item = next.slice(2).trim();
      // `- playwright:` — a dash item that is a bare key with no value opens an
      // inline mapping. Anything else, including a name that merely contains a
      // colon, stays the string it has always been.
      const opener = allowsInlineMapping ? /^([^:\s][^:]*):$/.exec(item) : null;
      const dashIndent = raw.length - raw.trimStart().length;
      // A mapping opens only when an INDENTED BODY actually follows. `- github:`
      // with nothing under it keeps the exact string it has always produced —
      // this reading widens what parses, it does not reinterpret a shape that
      // was already reaching the caller.
      const body: string[] = [];
      if (opener) {
        for (let j = i + 1; j < lines.length; j += 1) {
          const bodyLine = lines[j] ?? '';
          // A blank line does not close the block — only a line indented no
          // deeper than the dash does, which is the next item or the next key.
          if (bodyLine.trim() && bodyLine.length - bodyLine.trimStart().length <= dashIndent) break;
          body.push(bodyLine);
        }
      }
      if (!opener || !body.some(line => line.trim())) {
        list.push(stripFrontmatterQuotes(item));
        continue;
      }
      i += body.length;
      list.push({ [opener[1]!.trim()]: parseIndentedMapping(body) });
    }
    data[key] = list.length > 0 ? list : '';
  }

  return data;
}

function parseMarkdownAgentDefinition(fileName: string, content: string): AgentDefinition | null {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') return null;

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) return null;

  const frontmatter = parseFrontmatter(lines.slice(1, endIndex).join('\n'));
  const systemPrompt = lines.slice(endIndex + 1).join('\n').trim();
  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim()
    ? frontmatter.name
    : basename(fileName, extname(fileName));

  return normalizeUserAgentDefinition({
    ...frontmatter,
    name,
    systemPrompt,
  }, `${fileName}`);
}

function readJsonAgentDefinitions(
  workspaceRootPath: string,
  onInvalidDefinition?: (failure: AgentDefinitionLoadFailure) => void,
): AgentDefinition[] {
  const configPath = join(workspaceRootPath, 'config.json');
  if (!existsSync(configPath)) return [];

  // A3: an unreadable or unparseable config.json fails THIS file alone, with
  // a diagnostic — the markdown definitions beside it still load. A missing
  // `orchestratorAgents` key stays silent: config.json legitimately carries
  // other settings.
  let entries: unknown;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as { orchestratorAgents?: unknown } | null;
    entries = raw?.orchestratorAgents;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onInvalidDefinition?.({ file: configPath, reason });
    debug(`Agent definitions config skipped: ${configPath} — ${reason}`);
    return [];
  }
  if (!Array.isArray(entries)) return [];

  // A3: per ENTRY, same contract as the markdown loader above — a malformed
  // definition is skipped and named, never list-fatal. Fail-closed is
  // unchanged: the malformed entry itself never loads.
  return entries.flatMap((entry: UserAgentDefinition, index): AgentDefinition[] => {
    try {
      return [normalizeUserAgentDefinition(entry, `orchestratorAgents[${index}]`)];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onInvalidDefinition?.({ file: configPath, reason });
      debug(`Agent definition skipped: ${configPath} — ${reason}`);
      return [];
    }
  });
}

function readMarkdownAgentDefinitionsFromDir(
  dir: string,
  onInvalidDefinition?: (failure: AgentDefinitionLoadFailure) => void,
): AgentDefinition[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter(entry =>
      entry.isFile()
      && extname(entry.name).toLowerCase() === '.md'
      // AGENTS.md / CLAUDE* are instruction files, never agent definitions.
      && !isInstructionFile(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const file = join(dir, entry.name);
      // A2: per FILE, never directory-fatal. One malformed definition used to
      // throw out of this loop and take every sibling (and the subagent spawn
      // that triggered the load) with it — the same failure class A1 removed
      // from the capability materializer.
      try {
        const parsed = parseMarkdownAgentDefinition(entry.name, readFileSync(file, 'utf-8'));
        return parsed ? [parsed] : [];
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        onInvalidDefinition?.({ file, reason });
        debug(`Agent definition skipped: ${file} — ${reason}`);
        return [];
      }
    });
}

/**
 * Session-free strict validation of one markdown definition file against THIS
 * loader's parse — the strict half of the A2 skip, mirroring
 * `validatePiRuntimeAgentDefinitionContent` for the capability pipeline. The
 * two parsers differ (this one validates `toolset`, for example), so the
 * doctor runs both. A file without frontmatter is `ok`: this loader never
 * treats it as an agent definition in the first place.
 */
export function validateMarkdownAgentDefinitionContent(
  fileName: string,
  content: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    parseMarkdownAgentDefinition(fileName, content);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function readUserAgentDefinitions(
  workspaceRootPath?: string,
  onInvalidDefinition?: (failure: AgentDefinitionLoadFailure) => void,
): AgentDefinition[] {
  if (!workspaceRootPath) return [];
  return [
    ...readJsonAgentDefinitions(workspaceRootPath, onInvalidDefinition),
    ...readMarkdownAgentDefinitionsFromDir(workspaceRootPath, onInvalidDefinition),
  ];
}

/**
 * Load agent definitions for the compatibility flat map (W8 owns the final
 * qualified-alias policy; native-sources.ts already records per-scope
 * provenance). The four sources this branch has, each stamped with its rung of
 * {@link AGENT_DEFINITION_SCOPE_PRIORITY}:
 *  - built-ins — `builtin`
 *  - global `CONFIG_DIR/agents` markdown — `user`, the page's `~/.claude/agents/`
 *  - `<workspaceRootPath>/config.json` orchestratorAgents + `<workspaceRootPath>/*.md`
 *    — `workspace`, ONE rung read in two formats from ONE directory, and a rung
 *    the page does not have (see {@link AgentDefinitionScope}: it is the
 *    host-owned workspace store, not managed settings)
 *  - trusted active-project `.nessy-agent/agents` markdown (fail-closed) —
 *    `project`, the page's `.claude/agents/`
 *
 * Precedence is the scope table, not the order these loops happen to run in:
 * a strictly lower rung never displaces a higher one. At HEAD the two rules
 * agree — the loops already ascend — which is the point. The rung P6.317 (2)
 * adds (`session`, the `--agents` flag) can then be appended anywhere and still
 * land at priority 2.
 */
export function loadAgentDefinitions(options: AgentDefinitionOptions = {}): AgentDefinition[] {
  const defs = new Map<string, AgentDefinition>(BUILTIN_AGENT_DEFINITIONS.map(def => [def.name, {
    ...def,
    scope: 'builtin' as const,
    tools: [...def.tools],
    ...(def.disallowedTools ? { disallowedTools: [...def.disallowedTools] } : {}),
  }]));

  // Runtime orchestration is closed-world: when the host supplies a pinned
  // snapshot, built-ins plus that snapshot are the only definitions. Native
  // filesystem definitions must reach this process through the snapshot.
  // A filesystem definition may not claim a RESERVED name. Built-ins have
  // always been overwritable by a same-named user file, which is a deliberate
  // override; `fork` is not, because "inherit the parent session's prompt,
  // tools, model and permission mode" is not something a file may redefine.
  const setUnlessReserved = (def: AgentDefinition, scope: AgentDefinitionScope): void => {
    if (isForkAgentName(def.name)) return;
    // P6.902: the scope table decides, not the order of the loops below. A
    // strictly lower rung is refused; an equal rung still overwrites, so
    // "last file read wins" inside one directory is unchanged.
    if (agentScopeOutranks(defs.get(def.name)?.scope, scope)) return;
    defs.set(def.name, { ...def, scope });
  };

  /**
   * P6.792 — stamp the folder-trust verdict for an inline `mcpServers` map at
   * the ONE place the scope is known, and drop the map where it is not granted.
   *
   * Every filesystem branch below passes `true`, and that is a statement rather
   * than a formality: the global directory is the page's own exempt scope, the
   * workspace route is a host-owned root the user cannot open as a project at
   * all (P6.902 corrected this sentence, which used to call that route
   * "managed"), and the project branch is reached only when
   * `options.projectTrusted === true`. Stamping keeps the reasoning readable at
   * the consumer, which otherwise cannot tell "trusted" from "never asked".
   */
  const withInlineTrust = (def: AgentDefinition, trusted: boolean): AgentDefinition => {
    if (def.mcpServerInline === undefined) return def;
    if (!trusted) {
      const { mcpServerInline: _dropped, mcpServerInlineTrusted: _verdict, ...rest } = def;
      return rest;
    }
    return { ...def, mcpServerInlineTrusted: true };
  };

  if (options.runtimeDefinitions === undefined) {
    // The user-level directory: the page's `~/.claude/agents/` clause, an
    // inline server there loads "without checking trust for the folder the
    // agent file came from".
    for (const def of readMarkdownAgentDefinitionsFromDir(join(CONFIG_DIR, 'agents'), options.onInvalidDefinition)) {
      setUnlessReserved(withInlineTrust(def, true), 'user');
    }

    // The workspace route: `config.json` orchestratorAgents and the `*.md`
    // beside it, both read from `workspaceRootPath` — one host-owned directory
    // in two formats, so ONE rung. This comment named it the page's "one that
    // managed settings supplies" clause until P6.902 measured the directory:
    // it is `ProjectHandleService`'s managed ROOT (never a valid user project),
    // not the page's managed SETTINGS rung, which this fork serves from
    // `<systemDir>/agents` on the capability route instead.
    for (const def of readUserAgentDefinitions(options.workspaceRootPath, options.onInvalidDefinition)) {
      setUnlessReserved(withInlineTrust(def, true), 'workspace');
    }

    if (options.projectRoot && options.projectTrusted === true) {
      // The gated scope, and the grant is this branch's own precondition.
      for (const def of readMarkdownAgentDefinitionsFromDir(join(options.projectRoot, NESSY_AGENT_PROJECT_DIR, 'agents'), options.onInvalidDefinition)) {
        setUnlessReserved(withInlineTrust(def, true), 'project');
      }
    }
  }

  for (const runtimeDefinition of options.runtimeDefinitions ?? []) {
    const requestedName = normalizeName(runtimeDefinition.name);
    const qualifiedName = runtimeDefinition.definitionKey
      ? normalizeName(runtimeDefinition.definitionKey)
      : undefined;
    const builtinCollision = BUILTIN_AGENT_NAME_SET.has(requestedName);
    if (builtinCollision && !qualifiedName) {
      throw new Error(`Runtime agent "${runtimeDefinition.name}" collides with an immutable built-in without a qualified definition key`);
    }
    const name = builtinCollision ? qualifiedName! : requestedName;
    if (!name || !runtimeDefinition.systemPrompt.trim()) continue;
    const aliases = [...new Set([
      ...(runtimeDefinition.aliases ?? []).map(normalizeName),
      ...(qualifiedName ? [qualifiedName] : []),
    ].filter(alias => alias && !BUILTIN_AGENT_NAME_SET.has(alias)))];
    // P6.902: deliberately NOT routed through the scope table. The snapshot is
    // closed-world — the filesystem branch above did not run — and its
    // precedence was already decided by the capability resolver, which is where
    // the managed rung (`<systemDir>/agents`) is contested. Stamping a scope
    // here would be inventing provenance the descriptor does not carry.
    //
    // P6.792, fail-closed: the host snapshot is the ONE branch where an inline
    // map can arrive with no verdict, because `...runtimeDefinition` spreads
    // whatever the descriptor carried. The same helper the filesystem branches
    // use removes it — one rule, one place, so a later reader cannot find a
    // definition whose servers nobody decided about.
    defs.set(name, withInlineTrust({
      ...runtimeDefinition,
      name,
      ...(aliases.length ? { aliases } : {}),
      tools: [...runtimeDefinition.tools],
      ...(runtimeDefinition.disallowedTools
        ? { disallowedTools: [...runtimeDefinition.disallowedTools] }
        : {}),
      ...(runtimeDefinition.skillKeys ? { skillKeys: [...runtimeDefinition.skillKeys] } : {}),
      ...(runtimeDefinition.mcpServerKeys ? { mcpServerKeys: [...runtimeDefinition.mcpServerKeys] } : {}),
    }, runtimeDefinition.mcpServerInlineTrusted === true));
  }

  return [...defs.values()];
}

export function resolveAgentDefinition(name: string, options: AgentDefinitionOptions = {}): AgentDefinition {
  const normalized = normalizeName(name);
  // Resolved BEFORE any definition is loaded, so no workspace, project, or
  // plugin-supplied definition — and no alias on one — can shadow or
  // impersonate the reserved fork type.
  if (normalized === FORK_AGENT_NAME) return FORK_AGENT_DEFINITION;
  const defs = loadAgentDefinitions(options);
  // Exact-first, then the documented separator-insensitive fold. The order
  // matters: with both `code-reviewer` and `codereviewer` defined, each exact
  // spelling must still resolve to itself, so no name that resolves today can
  // change target. The fold runs on BOTH sides, which is what makes the rule
  // symmetric — a definition declaring `name: Code Reviewer` is stored as
  // `"code reviewer"` (normalizeName lowercases but keeps the space) and is
  // otherwise unreachable by the kebab spelling a model actually emits.
  //
  // Deliberately NOT folded: the reserved-fork short-circuit above. Folding it
  // would let `for_k` / `f-o-r-k` claim the reserved type while
  // `setUnlessReserved` still blocks only the exact spelling — a shadowing
  // widening, not a convenience.
  const folded = foldAgentName(name);
  const match = defs.find(def => def.name === normalized)
    ?? defs.find(def => def.aliases?.includes(normalized))
    ?? defs.find(def => foldAgentName(def.name) === folded)
    ?? defs.find(def => def.aliases?.some(alias => foldAgentName(alias) === folded));
  if (!match) {
    throw new Error(`Unknown agent "${name}". Available agents: ${[...defs.map(def => def.name), FORK_AGENT_NAME].join(', ')}`);
  }
  return match;
}

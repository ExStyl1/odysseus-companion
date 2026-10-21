/**
 * Our agent definitions, expressed in the Claude Agent SDK's OWN subagent
 * mechanism.
 *
 * The owner's rule for this fork: Pi is ours and is built to Claude Code's
 * documentation; Claude runs "as-is" so we do not diverge from its real
 * behaviour. So this file reimplements no orchestration. It is a pure
 * translation from the ONE definition source the capability layer already
 * produces (`materializePiRuntimeAgentDefinitions`) into the option the SDK
 * documents for exactly this purpose.
 *
 * Both contracts name the same option. They were read SEPARATELY — this repo has
 * already shipped wrong field names off a paraphrase, so neither is allowed to
 * stand in for the other:
 *
 * - `agent-sdk/subagents.md` § *Overview*, fetched raw 2026-08-13, line 18:
 *   "**Programmatically**: use the `agents` parameter in your `query()`
 *   options."
 * - the installed `@anthropic-ai/claude-agent-sdk@0.3.218` `sdk.d.ts:1348`:
 *   `agents?: Record<string, AgentDefinition>;`. Its jsdoc, `sdk.d.ts:1343-1344`,
 *   adds "Programmatically define custom subagents that can be invoked via the
 *   Agent tool. Keys are agent names, values are agent definitions." — that
 *   sentence is the TYPES only and does NOT appear on the doc page; an earlier
 *   draft of this file attributed it to both.
 *
 * The descriptor type is named `Pi…` for its transport, not its audience: it is
 * the capability layer's parsed form of a subagent markdown file, and every
 * field below is the author's declaration. Reusing it is deliberate — a second
 * reader of the same markdown is how the two runtimes would drift apart.
 *
 * ## Every field here must satisfy the runtime's schema, or NONE of them load
 *
 * Measured 2026-08-13 against the pinned SDK's own native binary
 * (`@anthropic-ai/claude-agent-sdk-darwin-arm64`, 0.3.218). The CLI parses the
 * whole `agents` record through one `z.record(z.string(), <agent schema>)`
 * inside a `try`, and its `catch` returns `[]` — so ONE entry failing the
 * schema deletes EVERY agent we sent, and the only trace is a CLI-internal
 * `Error parsing agents from JSON: …` line the host never sees. Confirmed end
 * to end: two agents sent, one with `prompt: ''`, and the CLI's init roster
 * came back with neither — the same "our agents simply are not there" shape
 * this file exists to fix.
 *
 * The schema it enforces on what we send: `description` and `prompt` are
 * required non-empty strings; `model` is trimmed and must be non-empty;
 * `maxTurns` must be a positive integer; `effort` is
 * `'low'|'medium'|'high'|'xhigh'|'max'` or an integer; `permissionMode` is the
 * six-member set below; `memory` is `'user'|'project'|'local'`. Our own wire
 * parse (`parsePiRuntimeAgentDefinitions`) already refuses an empty prompt, a
 * `maxTurns` below 1 and an out-of-set enum before a descriptor can reach here,
 * which is why no per-entry guard is duplicated below. A field added to this
 * builder WITHOUT that upstream guarantee reintroduces the all-or-nothing
 * failure, silently.
 */
import type { AgentDefinition, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_AGENT_NAMES,
  FORK_AGENT_NAME,
  type AgentIsolation,
  type AgentTier,
  type AgentToolset,
} from '../agents/definitions.ts';
import {
  buildBuiltinAgentTierNotice,
  type BuiltinAgentTierModelMap,
} from '../agents/builtin-tier-notice.ts';
import type { CapabilitySnapshotMaterializer } from '../capabilities/materializer.ts';
import { isClaudeProjectAgentCopyKey } from '../capabilities/native-sources.ts';
import {
  assertSkillInvocationBudget,
  collectSkillDisallowedTools,
  formatRuntimeSkillInvocation,
  materializeRuntimeSkillInvocation,
  parseSkillToolEntry,
  type RuntimeSkillHostContext,
  type SkillInvocationRecord,
} from '../capabilities/runtime-skill-content.ts';
import type { RuntimeSkillHandle } from '../capabilities/views.ts';
import { matchesToolPattern } from './mode-manager.ts';
import {
  isSubagentRosterTool,
  normalizePiRuntimeAgentToolName,
  subagentRosterToolGrant,
  type PiRuntimeAgentDefinitionDescriptor,
} from './pi-harness/runtime-agent-definition.ts';

/**
 * `sdk.d.ts:2073` — `PermissionMode = 'default' | 'acceptEdits' |
 * 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`. Ours (`mode-types.ts:27`)
 * is the same six since F1.1050 retired `'explore'` (read as `'plan'`); an
 * unrepresentable value is still omitted so the agent loads, rather than rejected.
 */
const SDK_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto',
]);

/**
 * `sdk.d.ts` AgentDefinition.effort — "Reasoning effort level for this agent. Either a named
 * level or an integer", typed `('low' | 'medium' | 'high' | 'xhigh' | 'max') | number`. Our
 * ThinkingLevel (`thinking-levels.ts:30`) additionally carries `'off'`, which is not a level
 * the SDK can express, so it is dropped rather than coerced to `'low'`.
 */
const SDK_EFFORT_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * `AgentDefinition` plus `isolation`, which the pinned SDK ACCEPTS and its
 * published typings do not declare. R12.
 *
 * The `.d.ts` is not the contract here, and the three sources that are all say
 * the same thing:
 *
 * - `sub-agents.md:221`, fetched raw 2026-08-16: "The `--agents` flag accepts
 *   JSON with a `prompt` field plus these frontmatter fields: `description`,
 *   `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`,
 *   `hooks`, `maxTurns`, `skills`, `initialPrompt`, `memory`, `effort`,
 *   `background`, and `isolation`." Both fields this row is about are in that
 *   list; `AgentDefinition` in `sdk.d.ts:38-100` declares neither.
 * - the pinned native binary's OWN zod schema for that JSON, read as
 *   `isolation:<receiver>.enum(["worktree","remote"]).optional()` beside
 *   `hooks:<…>().optional()`. Its converter then forwards both onto the internal
 *   agent config: `...n.hooks&&{hooks:n.hooks},…,...n.isolation&&{isolation:n.isolation}`.
 *   **The RECEIVER name is not part of the contract and must not be quoted as
 *   one.** This line named `b.enum` inside an object `F3u`, measured on
 *   `@anthropic-ai/claude-agent-sdk-binary@0.3.218`; on the vendored 0.3.223 the
 *   same entry reads `E.enum` and that object name is gone (measured 2026-09-02,
 *   two occurrences). The minifier renames every run, so the field and its two
 *   arms are the claim and the identifier is noise.
 * - the CLI reaches that schema from the SDK's `agents` option, not only from
 *   the flag: the control-plane initialize handler runs
 *   `if(e.agents)m=BJr(e.agents,"flagSettings")`, the same
 *   `BJr` → `Ta_().parse` → per-entry converter chain, and `sdk.mjs` puts our
 *   object on the wire verbatim (`agents:this.initConfig?.agents`, no field
 *   whitelist).
 *
 * Sending a key the schema knows is also the SAFE direction against SDK drift,
 * which the all-or-nothing note in the file header makes load-bearing: the
 * schema is a plain object schema, so it STRIPS unknown keys rather than
 * rejecting them. If a later SDK drops `isolation`, this becomes inert; it
 * cannot become the "one entry fails, every agent vanishes" failure.
 *
 * P3.205 — **that safety is also the whole failure mode, and until this row
 * nothing checked the prose.** "Becomes inert" means an author who wrote
 * `isolation: worktree` silently gets no isolation, with no signal on either
 * side: the `ADVERTISED` class exactly. `__tests__/claude-runtime-agent-isolation-schema.test.ts`
 * is the tripwire — it reads the vendored artefacts themselves and fails loudly
 * on an upstream drop, pinning BOTH channels (this definition field, and the
 * Agent tool's own `isolation` input that outranks it, see below).
 *
 * Typed as our own {@link AgentIsolation} rather than the SDK's wider
 * `'worktree' | 'remote'` on purpose: `'remote'` is a value no descriptor can
 * carry, and widening the type here is how one would eventually be sent.
 *
 * THERE IS A SECOND CHANNEL, and it OUTRANKS this one — worth knowing before a
 * later row treats the definition as the only place isolation is decided. The
 * Agent tool's own input declares it (`sdk-tools.d.ts`, `AgentInput.isolation?:
 * "worktree" | "remote"`), and the binary resolves the pair as
 * `j = s ?? U.isolation` — the CALL-SITE value first, the author's declaration
 * only as the fallback. So a model passing `isolation` on an Agent call can
 * override what the author declared. The definition field is still the right
 * home for an author's declaration, which is what this row is about; the
 * override is a separate question nobody has asked yet.
 */
type SdkAgentDefinition = AgentDefinition & { isolation?: AgentIsolation };

/**
 * A degradation this runtime imposes on ONE agent, addressed to the USER.
 *
 * Not the diagnostic channel. `ClaudeRuntimeAgentModelPolicy.onDiagnostic` ends
 * at `BaseAgent.debug` → `SessionManager`'s `sessionLog.info` — a log file — and
 * is `undefined` outright when no `onDebug` was assigned. R12's whole point is
 * that a degradation nobody is told about is the defect, so the notice channel
 * is separate BY TYPE, and its one producer routes it to a channel the user
 * actually sees (`ClaudeAgent` yields it as an `info`/`warning` event, which
 * `SessionManager` persists into the transcript).
 */
export interface ClaudeRuntimeAgentNotice {
  /** Capability key of the affected agent. */
  agentKey: string;
  /**
   * `definitionDigest` — the content hash of the whole definition. The caller
   * de-duplicates on it, so one agent announces once per session and announces
   * AGAIN when its author edits the definition, which is exactly when the
   * degradation may have changed.
   */
  definitionDigest: string;
  /** One sentence, written for a user reading a transcript banner. */
  message: string;
}

/**
 * The name the model invokes, chosen by the SAME rule the Pi side applies at
 * `pi-agent-server/src/orchestrator/runtime-agent-definitions.ts:350`
 * (`name: hasUnqualifiedAlias ? descriptor.name : descriptor.key`), so one
 * agent answers to one name on both runtimes.
 *
 * The rule is load-bearing here for a reason Pi does not have: Pi registers a
 * `name` PLUS an `aliases` list, but the SDK option is a plain
 * `Record<string, AgentDefinition>`. Two plugins bundling a same-named agent
 * both carry `selectedAsUnqualifiedAlias: false`; keying both by `name` would
 * not make them ambiguous, it would silently DROP one on Record assignment.
 *
 * No guard against the SDK's own built-in names is applied, and that is
 * deliberate rather than an oversight — overriding one is Claude's documented
 * behaviour, not an accident: `sub-agents.md` § *Built-in subagents* says "A
 * user or project subagent named `Explore` overrides the built-in and keeps its
 * own `model` field", and `agent-sdk/subagents.md` says "`agents` passed to
 * `query()` override a filesystem agent with the same name." Adding a guard the
 * SDK does not have is exactly the divergence the owner's rule forbids.
 */
function agentNameOf(descriptor: PiRuntimeAgentDefinitionDescriptor): string {
  const chosen = descriptor.selectedAsUnqualifiedAlias ? descriptor.name : descriptor.key;
  // P3.277, and it sits ON TOP of the rule above rather than replacing it. Once
  // the bundled four are registered here, a descriptor that answers to one of
  // their names would OVERWRITE it on Record assignment — and Pi does not let
  // that happen: `loadAgentDefinitions` reads `BUILTIN_AGENT_NAME_SET.has(name)`
  // and stores such a definition under its qualified key, keeping the built-in
  // reachable ("Runtime agent … collides with an immutable built-in" is the
  // throw for the case with no key to fall back to). Both runtimes read the SAME
  // descriptors, so without this line an imported `reviewer` would shadow the
  // bundled one on claude and sit beside it on Pi.
  //
  // Deliberately OURS only, and not extended to the SDK's own built-ins: that
  // exclusion is the subject of this function's second note, and overriding
  // `Explore` is documented behaviour we must not take away.
  return RESERVED_AGENT_NAMES.has(normalizeBuiltinAgentName(chosen)) ? descriptor.key : chosen;
}

/**
 * The name-fold `loadAgentDefinitions` applies before its own built-in-collision
 * test (`normalizeName` there: trim + lowercase). Reproduced rather than
 * imported because that helper is module-private, and a case-only difference is
 * exactly how a collision test stops colliding.
 */
function normalizeBuiltinAgentName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * `BUILTIN_AGENT_NAME_SET`'s membership, rebuilt from the two exported halves —
 * the four bundled names plus the RESERVED `fork`. The set itself is
 * module-private; its two inputs are not, and rebuilding from them is what keeps
 * a fifth builtin from being guarded on one runtime only.
 *
 * `fork` is in it for the reason its own docblock gives: "inherit the parent
 * session's prompt, tools, model and permission mode" is not something a
 * definition may redefine, and a plugin-supplied file named `fork` would
 * otherwise substitute its own.
 */
const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(
  [...BUILTIN_AGENT_NAMES, FORK_AGENT_NAME].map(normalizeBuiltinAgentName),
);

/**
 * The tool grant each BUILTIN toolset becomes on this runtime — P3.277.
 *
 * `BUILTIN_AGENT_DEFINITIONS` declares Pi's OWN tool names (`read`, `grep`,
 * `find`, `ls`, `bash`, `edit`, `write`), which is correct for the runtime they
 * were written for and is not what `AgentDefinition.tools` wants. The vendored
 * SDK's own example for that field spells them differently — `sdk.d.ts`, the
 * `agents` option's jsdoc: `tools: ['Read', 'Grep', 'Glob', 'Bash']` — so
 * forwarding the declared list verbatim would hand the SDK four names it does
 * not have, which is the input `errors.md` § *Agent would be spawned with zero
 * tools* describes (that page's refusal is for UNRESOLVABLE entries).
 *
 * So the translation is by TOOLSET, not name by name, and it is written out
 * rather than derived. `PI_RUNTIME_AGENT_TOOL_ALIASES` is the only table that
 * relates the two vocabularies and it runs the other way — Claude spelling to Pi
 * tool — and is many-to-one (`read` is the target of `read`, `readfile`,
 * `readmanyfiles` and `notebookread`), so inverting it would pick a name by
 * accident. Six entries, each read off the vendored artefacts:
 *
 * - `Read`, `Grep`, `Glob`, `Bash` — the four in `sdk.d.ts`'s own example.
 * - `Edit`, `Write` — `sdk-tools.d.ts` declares `FileEditInput` and
 *   `FileWriteInput` beside `FileReadInput`, `GlobInput`, `GrepInput` and
 *   `BashInput`; those six are the whole file-and-shell set it carries.
 * - `ls` has NO counterpart and is dropped rather than guessed: there is no
 *   `Ls`/`LS` input type in `sdk-tools.d.ts` at all. Listing a directory on this
 *   runtime is `Glob` or `Bash`, both already granted wherever `ls` was.
 *
 * The `full` list is deliberately NOT "omit `tools` and inherit everything".
 * Inheriting would hand `worker` `WebFetch`, `WebSearch`, `Agent` and every
 * `mcp__session__*` tool that its Pi twin has never had, which is a widening of
 * a bundled agent's authority made silently on one runtime — the exact shape of
 * divergence this row exists to remove.
 */
const BUILTIN_TOOLSET_SDK_TOOLS: Readonly<Record<AgentToolset, readonly string[]>> = Object.freeze({
  'read-only': Object.freeze(['Read', 'Grep', 'Glob']),
  full: Object.freeze(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']),
});

/**
 * The four agents this fork BUNDLES, in the SDK's own shape — P3.277.
 *
 * They reach Pi through `loadAgentDefinitions`, which seeds its map with
 * `BUILTIN_AGENT_DEFINITIONS` before any runtime definition. Nothing ever handed
 * them to this builder, so `scout`, `planner`, `worker` and `reviewer` answered
 * on Pi and were `Agent type not found` on claude — including the `reviewer` the
 * bundled review skill delegates to (P3.204) and the `worker` a forked skill
 * defaults to (`DEFAULT_SKILL_FORK_AGENT`).
 *
 * ## What the SDK accepts as-is, measured field by field against `AgentDefinition`
 *
 * | builtin field | SDK field  | verdict |
 * | ------------- | ---------- | ------- |
 * | `name`        | record key | as-is |
 * | `description` | `description` | as-is |
 * | `systemPrompt`| `prompt`   | as-is, renamed |
 * | `tools`       | `tools`    | NOT as-is — Pi's spellings; see {@link BUILTIN_TOOLSET_SDK_TOOLS} |
 * | `toolset`     | —          | no SDK field; it is what the `tools` list above expresses |
 * | `tier`        | `model`    | MAPPED since P6.154, through {@link ClaudeRuntimeAgentModelPolicy} |
 *
 * ## `tier`, and the objection that did not survive being checked (P6.154)
 *
 * This table used to read "no SDK field, and DROPPED rather than mapped", and
 * the paragraph under it argued that inventing an alias per tier would pin a
 * model the user's connection may not serve — the failure `resolvedModelField`
 * exists to avoid. The premise was right and the conclusion was too wide.
 *
 * Nothing has to be invented. The HOST already resolves the `small` tier for Pi
 * (`SessionManager`: `resolveGatewayFastModelId(connection)`, T1), and that
 * function returns an id the connection DEMONSTRABLY serves — it matches the
 * gateway's own `fast` ALIAS as published by the catalogue refresh, checks it
 * against the managed allowlist, and returns `undefined` for a catalogue with
 * none. So the tier maps to a real served id or to nothing at all, and neither
 * branch pins an unserved model.
 *
 * Native mechanism, asked and answered — CONFIGURE, not build: the SDK's own
 * `AgentDefinition.model` (`sdk.d.ts:55-58`, "Model alias (e.g. 'fable',
 * 'opus', 'sonnet', 'haiku') or full model ID"), already used for imported
 * agents and simply never handed the builtins' tier.
 *
 * `medium` and `big` stay unmapped, and that is PARITY rather than residue:
 * Pi's own map is `fastModelId ? { small: fastModelId } : undefined`, so on
 * both runtimes those two tiers resolve to the session model. The remaining
 * honest gap is the NO-ALIAS arm — `scout` runs on the session model on both
 * runtimes there — which is why the diagnostic says the tier is inert on this
 * connection rather than claiming a runtime difference.
 *
 * REFUSED as the mechanism: `CLAUDE_CODE_SUBAGENT_MODEL` is ONE model for every
 * delegated child and cannot express three tiers. It is also a hazard that
 * outlives this row; the measurement is pinned in `config/subagent-model.ts`.
 *
 * None of the four declares `disallowedTools`, `maxTurns`, `permissionMode`,
 * `effort`, `memory`, `background` or `isolation`, so no other field is in play;
 * a future builtin that does gains nothing here until this table grows with it.
 */
export function buildClaudeRuntimeBuiltinAgents(
  /**
   * P6.154 — the host's tier resolution, in the same shape Pi's own
   * `tierModelMap` takes, so a reader comparing the two runtimes is comparing
   * one structure. Absent, or absent for a given tier, means the agent
   * registers with no `model` and runs on the session's — which is exactly what
   * Pi does with an unset entry.
   */
  tierModelMap?: ClaudeRuntimeAgentTierModelMap,
): Record<string, SdkAgentDefinition> {
  const agents: Record<string, SdkAgentDefinition> = {};
  for (const definition of BUILTIN_AGENT_DEFINITIONS) {
    const tierModel = tierModelMap?.[definition.tier];
    agents[definition.name] = {
      description: definition.description,
      prompt: definition.systemPrompt,
      tools: [...(BUILTIN_TOOLSET_SDK_TOOLS[definition.toolset] ?? BUILTIN_TOOLSET_SDK_TOOLS['read-only'])],
      // Omitted entirely rather than sent as `model: undefined`: the SDK parses
      // the whole `agents` record through one `z.record`, and this file's own
      // header records that ONE entry failing the schema deletes EVERY agent we
      // sent, silently.
      ...(tierModel ? { model: tierModel } : {}),
    };
  }
  return agents;
}

/**
 * P6.154 — the tiers the host could resolve for this session's connection.
 *
 * Deliberately the same shape as Pi's `tierModelMap` (`SessionManager`, T1),
 * because the two runtimes reading differently-shaped answers to one question
 * is how they drift. Only `small` is ever populated today, on both.
 */
export type ClaudeRuntimeAgentTierModelMap = BuiltinAgentTierModelMap;

/**
 * P6.160 — the SDK's own model aliases, exactly as its types spell them.
 *
 * `sdk.d.ts:55-58` on `AgentDefinition.model`: "Model alias (e.g. 'fable',
 * 'opus', 'sonnet', 'haiku') or full model ID". Each has a documented
 * environment variable that decides what it resolves to —
 * `model-config.md#environment-variables`, the `ANTHROPIC_DEFAULT_OPUS_MODEL`
 * row verbatim: "The model to use for `opus`, or for `opusplan` when Plan Mode
 * is active."
 */
export const CLAUDE_SDK_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export type ClaudeSdkModelAlias = (typeof CLAUDE_SDK_MODEL_ALIASES)[number];

/** P6.160 — alias to the id the host seeded it to on this spawn. */
export type ClaudeRuntimeAgentAliasModelMap =
  Readonly<Partial<Record<ClaudeSdkModelAlias, string>>>;

/**
 * P6.154, then P6.156 — the sentence a session owes when a bundled agent's tier
 * is inert. A thin claude-side seam over the HOST builder, which is where the
 * text and the rule now live ({@link buildBuiltinAgentTierNotice}).
 *
 * It reaches {@link ClaudeRuntimeAgentModelPolicy.onTierNotice} and NOT the
 * banner, for the reason P6.154 measured at the call site: routed to the banner
 * it fires on most connections and contradicts an existing named control. That
 * grade is unchanged and P6.156 makes it matter more, not less.
 *
 * TWO THINGS P6.156 CHANGED HERE, both deliberate and both recorded because
 * they revise a decision this file made hours earlier:
 *
 *  1. **The line is in the locales.** It was hardcoded English, which no other
 *     user-facing diagnostic on this path is.
 *  2. **`medium` and `big` are named too**, where this returned `[]` unless
 *     `small` was missing. The reason given for the narrower scope was that
 *     announcing the other two would claim a divergence measurement does not
 *     support — true of DIVERGENCE, and it does not carry to the capability:
 *     nothing resolves those tiers on any of the three, so the user asking why
 *     `worker` is not on a bigger model was told nothing at all. The host
 *     sentence answers that and states the uniformity in itself, so it can
 *     never be read as a per-runtime loss and never becomes a switch cost.
 */
export function claudeBuiltinAgentTierDiagnostics(
  tierModelMap?: ClaudeRuntimeAgentTierModelMap,
): string[] {
  return buildBuiltinAgentTierNotice(tierModelMap);
}

/**
 * Translate the session's materialized agent definitions into the SDK's
 * `agents` option. Total and lossless for every field the SDK can express;
 * silently narrowing for the two it expresses differently (see the sets above).
 *
 * Deliberately NOT forwarded, both recorded rather than forgotten:
 *
 * - `skillKeys` → `skills`. **Refused, and the refusal is the point of R10 — the
 *   bodies are inlined by us instead** (see {@link materializeClaudeRuntimeAgentSkills}).
 *   The SDK's field is "Array of skill names to preload into the agent context";
 *   ours holds resolved capability KEYS, which are not those names, so the SDK
 *   would resolve each name against ITS OWN directories. The only one a live
 *   session has is `.claude/skills` inside the user's open repository, so a name
 *   match would substitute an arbitrary unvetted file for our vetted skill,
 *   silently. Its preload also carries none of our per-skill `disallowed-tools`,
 *   none of the model/agent compatibility checks and none of the invocation
 *   budget, so "restored" would have meant "downgraded, invisibly".
 * - `mcpServerKeys` → `mcpServers`. **NO LONGER a blanket drop since P6.791.**
 *   `sdk.d.ts:120` types the target as `AgentMcpServerSpec = string |
 *   Record<string, McpServerConfigForProcessTransport>` — either a NAME
 *   referring to a server the turn already configured, or a whole
 *   process-transport config — and our capability KEYS are neither, which is
 *   why the whole declaration used to be dropped and announced. The missing
 *   piece was a translation, not a decision: `mcpWireNamesByKey` (built by
 *   `capabilities/views.ts`'s `mcpWireNamesByCapabilityKey`) turns a key into
 *   the wire name the session actually registered its tools under, and that
 *   name IS the documented reference form. A key the map cannot resolve is
 *   still dropped and still announced, per agent and BY NAME — sending an
 *   unresolved key would hand the child whatever server answered to it. The
 *   INLINE form is still not carried (P6.792 owns its folder-trust gate).
 *   A `mcp__<server>__*` entry in `tools` is unaffected — that path is `tools`,
 *   which is forwarded verbatim.
 * - `initialPrompt`. Both sides scope it to the MAIN session agent, not a
 *   subagent: `sdk.d.ts:69` says "Auto-submitted as the first user turn when
 *   this agent is the main thread agent", and the descriptor's own comment
 *   records the same reading of `sub-agents.md:297`. Every entry this function
 *   produces is a subagent registration — we never set the SDK's `agent` option —
 *   so forwarding it would fire a prompt at a turn it was not written for.
 * - `componentHooks`. **Cannot be carried from the value we hold, and is
 *   therefore ANNOUNCED — R12.** The SDK's side is not the obstacle: its schema
 *   takes a `hooks` block per agent (see {@link SdkAgentDefinition}). OURS is.
 *   The descriptor carries `parseSubagentFrontmatterHooks`'s NORMALIZED output —
 *   a Nessy `AutomationsConfig`, not the author's block — and that
 *   normalization is measurably lossy in both directions. Measured 2026-08-16
 *   on a real frontmatter block: `statusMessage: Guarding` is gone from the
 *   parsed value entirely, `timeout: 5` has become `timeoutMs: 5000`, a
 *   documented `type: prompt` hook has been folded onto Nessy's own
 *   `PromptAction` (which is a different thing from the `plugin-prompt` action
 *   the plugin path uses), and `frontmatterHookToAction` strips `if` and `once`
 *   by name. (That list named `async` too until C3.334 and `statusMessage` too
 *   until F1.1094: each of the three is declared on
 *   `packages/shared/src/automations/schemas.ts` `HookCommandActionSchema` and
 *   travels with the action now, so the lossiness is three fields narrower and
 *   the conclusion is unchanged.) Rebuilding the author's block out of that is a guess,
 *   and a wrong guess has two ways to be worse than the drop: it runs a command
 *   the author did not write, or it fails the CLI's single all-or-nothing
 *   `z.record(...)` parse and deletes EVERY agent in the session. Carrying it
 *   for real needs the RAW block on the descriptor — a
 *   `runtime-agent-definition.ts` change subject to that file's
 *   digest-key-ordering rule — not a second inverse translator here.
 *
 *   Refusing the agent instead was considered and rejected: Pi runs it, and
 *   withholding on Claude an agent the other runtimes admit is a NEW
 *   Claude-only degradation — the overshoot R10's review had to unwind.
 *
 *   The second sentence of this paragraph used to be that the host builds no
 *   `componentHookLayer` at all for `provider === 'anthropic'`, which was true
 *   when it was written and is not now: **P6.59 refuted the premise behind that
 *   gate and removed it**, so a claude session gets the SKILL layer and both
 *   subagent tiers like every other provider. What survives — and is the only
 *   reason this bullet still exists — is narrower: an agent registered through
 *   the SDK's `agents` option is spawned by the SDK, not as a host session, so
 *   nothing populates `piChildRestrictions.componentHooks` for it and the tiers
 *   that would carry its frontmatter hooks stay empty here whether or not the
 *   layer is built. The degradation is real and still announced.
 */
export interface ClaudeRuntimeAgentModelPolicy {
  /**
   * The model ids this session's connection can actually serve. Provided ONLY
   * for gateway/BYO connections (`providerType === 'claude-runtime'`), where
   * the SDK's alias vocabulary ('opus', 'sonnet', …) can never resolve — the
   * upstream serves its own catalog. Absent on plain anthropic connections,
   * where the alias semantics belong to the SDK and pass-through is correct.
   */
  servedModels?: readonly string[];
  /** Named in the diagnostic so the substitution announces both models. */
  sessionModel?: string;
  /**
   * P6.160 — what the SDK's four model aliases resolve to on THIS spawn, keyed
   * by alias, or absent when nothing was seeded.
   *
   * Present means the host wrote the matching `ANTHROPIC_DEFAULT_*_MODEL` into
   * the child's environment, so an agent declaring that alias is passed through
   * instead of substituted. It is ONE map for both halves on purpose: the env
   * and the admission are derived from the same object, so they cannot come to
   * disagree about which aliases are live.
   */
  aliasModels?: ClaudeRuntimeAgentAliasModelMap;
  /**
   * P6.154 — the models the host resolved for the orchestrator tiers, for the
   * BUNDLED agents only. Imported agents declare their own `model` and go
   * through {@link resolvedModelField}; a tier is not a declaration, it is the
   * host's own routing, which is why it enters here rather than on a descriptor.
   */
  tierModelMap?: ClaudeRuntimeAgentTierModelMap;
  /** The session debug channel, same sink the codex role denial uses. */
  onDiagnostic?: (message: string) => void;
  /**
   * P6.154 — the BUNDLED agents' inert-tier line, on a channel of its own.
   *
   * Separate from {@link onDiagnostic} deliberately: that one is bound to the
   * user-visible banner, and this fact is not a degradation relative to any
   * other runtime (Pi drops the same tier in the same arm and says nothing).
   * A caller that binds nothing here gets silence, which is what every existing
   * suite asserts.
   */
  onTierNotice?: (message: string) => void;
}

/**
 * The descriptor's `model` field, resolved against what the connection serves.
 *
 * Measured live 2026-08-14 (Q6-LIVE claim 3): `claude-security` declares
 * `model: opus`, the gateway serves no such id, and the SDK child died with
 * "model not available" — on Pi the same declaration is substituted with an
 * announcement (the claim-2 fix), and on codex the role inherits the session
 * model with a diagnostic. Passing the alias through unresolved is still the
 * right reading of `sdk.d.ts:56` for an ANTHROPIC upstream, so the
 * substitution only engages when the caller supplies the served set.
 */
function resolvedModelField(
  descriptor: PiRuntimeAgentDefinitionDescriptor,
  policy: ClaudeRuntimeAgentModelPolicy | undefined,
): { model?: string } {
  const declared = descriptor.model;
  if (!declared || declared === 'inherit') return {};
  const served = policy?.servedModels;
  if (!served?.length || served.includes(declared)) return { model: declared };
  // P6.160 — an ALIAS the host has seeded is not an unserved model, it is a
  // name that resolves inside the child. `servedModels` is built from the
  // connection's catalogue ids (`buildAgentModelPolicy`), so an alias can never
  // be a member of it and the substitution above would always fire — which is
  // why this admission sits beside the set rather than inside it.
  //
  // Gated on the MAP rather than on the alias literal: an alias with no
  // `ANTHROPIC_DEFAULT_*_MODEL` behind it would reach the child and resolve to
  // whatever the binary's own default is, which on a gateway is a model the
  // endpoint does not serve — the exact death (Q6-LIVE claim 3) this function
  // exists to prevent. No seed, no admission, and the substitution below still
  // fires with its warning.
  if (policy?.aliasModels?.[declared as ClaudeSdkModelAlias]) return { model: declared };
  policy?.onDiagnostic?.(
    `Imported agent ${descriptor.key} declares model "${declared}", which this connection `
    + `cannot serve; the agent inherits ${policy.sessionModel ?? 'the session model'} instead`,
  );
  return {};
}

/**
 * One agent's materialized skills, or the reason it may not run.
 *
 * The invocation RECORDS, not text: every check Pi's child-session admission
 * makes reads a field of the record, so handing the builder a pre-rendered
 * string would have made the ceilings unenforceable at the only place that
 * knows the agent's resolved model.
 */
export interface ClaudeRuntimeAgentSkillPayload {
  /** In `skillKeys` order, the order the prompt blocks are appended in. */
  invocations: readonly SkillInvocationRecord[];
  /**
   * Bodies whose `` !`<command>` `` placeholders were already replaced, keyed by
   * invocation key; an absent entry falls back to the record's own body, which
   * is what {@link formatRuntimeSkillInvocation}'s default parameter does.
   *
   * Empty on every route today, and that is a PRE-EXISTING decision this row did
   * not touch: `SessionManager` builds a `runtimeSkillContextExecutor` only for
   * `provider === 'pi'`, `BaseAgent.renderRuntimeSkillContext` returns an empty
   * map for every other provider, and `runtime-skill-context.test.ts` pins that
   * with "keeps runtime ! skill context Pi-only for every non-Pi provider". The
   * parameter exists so extending it is a wiring change rather than a rewrite of
   * this composition. Every OTHER documented substitution — `$ARGUMENTS`,
   * `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`,
   * `${CLAUDE_EFFORT}` and a plugin's non-sensitive user config — is already
   * applied inside `materializeRuntimeSkillInvocation`, so the body inlined here
   * is the substituted one, not the source text.
   */
  renderedBodies?: ReadonlyMap<string, string>;
  /**
   * Set instead of `invocations` when this agent's skills could not be
   * materialized. The agent is then NOT REGISTERED and the reason is announced —
   * the row's "fix it or say it, not silently" applied to its own failure path.
   */
  refusal?: string;
}

export interface ClaudeRuntimeAgentSkillInput {
  /**
   * Keyed by `descriptor.key`, never by the registered agent name: two plugins
   * may bundle a same-named agent, which is exactly why {@link agentNameOf}
   * exists, so a name-keyed map would collapse them.
   */
  byAgentKey: ReadonlyMap<string, ClaudeRuntimeAgentSkillPayload>;
  /**
   * The model this session actually runs. The skill `model:` ceiling compares
   * against the agent's EFFECTIVE model, which is the declared one when the
   * connection serves it and this otherwise — the same value
   * {@link resolvedModelField} resolves to.
   */
  sessionModel: string;
  /** Announces a refusal. Falls back to the model policy's channel. */
  onDiagnostic?: (message: string) => void;
}

/**
 * Materialize the skills each agent definition declares, ONCE, off the same
 * capability snapshot the Pi runtime reads.
 *
 * This is a port of `SessionManager`'s child-session admission — the ONE place
 * that already composes skill content for a subagent — not a second composer.
 * Its steps, in its order: select the declared skills out of the pinned view,
 * materialize each into a record, then assert the invocation budget. The two
 * COMPATIBILITY checks it makes next (`runtime-agent-skill-model-unavailable`,
 * `runtime-agent-skill-agent-unavailable`) live in {@link buildClaudeRuntimeAgents}
 * instead, because on this runtime the agent's model is resolved there.
 *
 * **Where it deliberately differs from Pi, and why.** Pi THROWS, and the throw
 * costs one spawn. Here a throw costs the whole session's agents: the CLI parses
 * the entire `agents` record through one `z.record(...)` inside a `try` whose
 * `catch` returns `[]`, as the file header records — so one bad skill would
 * delete every agent we sent and say nothing. Every failure is therefore scoped
 * to its own agent, which is then withheld rather than silently degraded.
 */
export async function materializeClaudeRuntimeAgentSkills(input: {
  definitions: readonly PiRuntimeAgentDefinitionDescriptor[] | undefined;
  materializer: CapabilitySnapshotMaterializer;
  /** The session's pinned skill view — `capabilityTurnRuntime.view.skills`. */
  skills: readonly RuntimeSkillHandle[];
  /** `capabilityTurnRuntime.view.generation`; stamped onto every record. */
  generation: string;
  sessionModel: string;
  host?: RuntimeSkillHostContext;
  renderedBodies?: ReadonlyMap<string, string>;
  onDiagnostic?: (message: string) => void;
}): Promise<ClaudeRuntimeAgentSkillInput> {
  const byAgentKey = new Map<string, ClaudeRuntimeAgentSkillPayload>();
  for (const descriptor of input.definitions ?? []) {
    if (!descriptor.skillKeys?.length) continue;
    // `selectByKey`'s rule, one agent at a time: a declared key the pinned view
    // does not carry is a refusal, never a quiet omission.
    const missing = descriptor.skillKeys.filter(
      key => !input.skills.some(skill => skill.key === key),
    );
    if (missing.length) {
      byAgentKey.set(descriptor.key, { invocations: [], refusal: `runtime-agent-skill-unavailable:${missing.join(',')}` });
      continue;
    }
    try {
      const invocations = await Promise.all(descriptor.skillKeys.map(key => materializeRuntimeSkillInvocation({
        materializer: input.materializer,
        skill: input.skills.find(skill => skill.key === key)!,
        generation: input.generation,
        ...(input.host ? { host: input.host } : {}),
      })));
      assertSkillInvocationBudget(invocations);
      byAgentKey.set(descriptor.key, {
        invocations,
        ...(input.renderedBodies ? { renderedBodies: input.renderedBodies } : {}),
      });
    } catch (error) {
      byAgentKey.set(descriptor.key, {
        invocations: [],
        refusal: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    byAgentKey,
    sessionModel: input.sessionModel,
    ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
  };
}

/**
 * The NAME half of a `disallowed-tools` entry, with the author's case intact.
 *
 * {@link parseSkillToolEntry} is the shared splitter and its name goes through
 * `canonicalTool`, which lowercases AND maps Claude's spellings onto Pi's
 * (`websearch` → `web_search`, `glob` → `find`, `task` → `subagent`). That is
 * right for MATCHING our own two lists against each other and wrong for the
 * value we hand the SDK, which knows only its own spellings: the installed
 * `sdk-tools.d.ts` carries `WebSearch` four times and `web_search` only inside
 * `web_search_requests`, a usage counter — so `web_search` in `disallowedTools`
 * would name no tool at all while reading as an enforced denial.
 *
 * The parameterization is dropped rather than forwarded for the same reason.
 * `sdk.d.ts:48`: "Array of tool names to explicitly disallow for this agent."
 * Names — so `Bash(rm:*)` would match nothing and the denial would again read as
 * enforced without being it. Denying the whole tool is the wider reading and the
 * safe direction.
 */
function sdkDeniedToolName(entry: string): string {
  const trimmed = entry.trim();
  const open = trimmed.indexOf('(');
  return (open === -1 ? trimmed : trimmed.slice(0, open)).trim();
}

/**
 * P6.309 (1) — the SAME skill materialization, for a runtime whose descriptors
 * travel as data rather than as SDK options.
 *
 * ## The gap this closes
 *
 * A codex role naming a skill started with no skill body at all. The machinery
 * existed and was claude-named — {@link materializeClaudeRuntimeAgentSkills} +
 * `applyAgentSkills` — and the codex side is a CALLER, not a second
 * implementation: `codex-agent.ts` hands `writeCodexConfig` the same descriptors
 * the Claude backend hands the SDK, so prepending the skill blocks to each
 * descriptor's `systemPrompt` before that hand-off gives codex the same body.
 *
 * ## Why a second entry point rather than reusing `buildClaudeRuntimeAgentOptions`
 *
 * That function returns SDK `AgentDefinition`s plus a model policy, alias map and
 * notice channel — three things codex has no use for, and one of them (the alias
 * map) is meaningless off the Claude SDK. This returns descriptors of the SAME
 * type it was given, so the codex call site stays a one-line substitution and
 * `writeCodexConfig` keeps reading the subset codex can express.
 *
 * ## The tool grant is deliberately LEFT ON the descriptor
 *
 * `applyAgentSkills` also narrows `tools`/`disallowedTools` from a skill's own
 * `disallowed-tools` frontmatter, and codex has no per-role tool policy to
 * narrow with. Those fields are carried through rather than stripped ON PURPOSE:
 * `buildCodexAgentRoles` already records any descriptor carrying them as an
 * UNHONOURED grant (P6.485) and `formatCodexUnhonouredRoleToolGrantNotice` says
 * so out loud. Stripping them here would hand the child a wider surface than its
 * skill declares AND remove the one sentence that admits it — which is the
 * hazard W8-g raised against building this arm blind.
 *
 * Refusals and un-materialized declarations are announced with the same two
 * sentences the claude path uses, from the same code, so the two runtimes cannot
 * word one degradation differently.
 */
export function applyRuntimeAgentSkillsToDescriptors(input: {
  definitions: readonly PiRuntimeAgentDefinitionDescriptor[] | undefined;
  skills: ClaudeRuntimeAgentSkillInput | undefined;
  announce?: (message: string) => void;
}): PiRuntimeAgentDefinitionDescriptor[] {
  const out: PiRuntimeAgentDefinitionDescriptor[] = [];
  for (const descriptor of input.definitions ?? []) {
    const payload = input.skills?.byAgentKey.get(descriptor.key);
    if (descriptor.skillKeys?.length && !payload) {
      input.announce?.(
        `Imported agent ${descriptor.key} declares ${descriptor.skillKeys.length} skill(s), `
        + 'which this turn did not materialize; the agent runs without them',
      );
    }
    const withSkills = input.skills && payload
      ? applyAgentSkills(descriptor, payload, input.skills.sessionModel)
      : undefined;
    if (withSkills && 'refusal' in withSkills) {
      input.announce?.(
        `Imported agent ${descriptor.key} is unavailable this turn: ${withSkills.refusal}`,
      );
      continue;
    }
    out.push(withSkills
      ? {
        ...descriptor,
        systemPrompt: withSkills.prompt,
        ...(withSkills.tools ? { tools: withSkills.tools } : {}),
        ...(withSkills.disallowedTools ? { disallowedTools: withSkills.disallowedTools } : {}),
      }
      : descriptor);
  }
  return out;
}

/**
 * Fold one agent's materialized skills into its SDK definition.
 *
 * Returns the fields to overlay, or a `refusal` — in which case the agent is
 * withheld from the record entirely.
 */
function applyAgentSkills(
  descriptor: PiRuntimeAgentDefinitionDescriptor,
  payload: ClaudeRuntimeAgentSkillPayload,
  effectiveModel: string,
): { prompt: string; tools?: string[]; disallowedTools?: string[] } | { refusal: string } {
  if (payload.refusal) return { refusal: payload.refusal };
  const { invocations } = payload;
  if (!invocations.length) return { prompt: descriptor.systemPrompt };
  for (const invocation of invocations) {
    // Both checks are `SessionManager`'s, verbatim in shape. Pi compares the
    // skill's `agent:` against the child's requested name AND the pinned
    // definition's key and name; `agentNameOf` returns one of those two, so the
    // pair below covers all three.
    const skillModel = invocation.restrictions.model?.trim();
    if (skillModel && skillModel !== 'inherit' && skillModel !== effectiveModel) {
      return { refusal: `runtime-agent-skill-model-unavailable:${skillModel}` };
    }
    const skillAgent = invocation.restrictions.agent?.trim();
    if (skillAgent && skillAgent !== 'inherit'
      && skillAgent !== descriptor.key && skillAgent !== descriptor.name) {
      return { refusal: `runtime-agent-skill-agent-unavailable:${skillAgent}` };
    }
  }
  const denied = collectSkillDisallowedTools(invocations);
  // `canonicalizeRuntimeSkillToolGrants` is deliberately not called: `allowed-tools` stopped
  // being a ceiling on 2026-08-13 ("It does not restrict which tools are
  // available"), so on the Pi child path it now returns the inherited list
  // unchanged. Only the removal below narrows, which is the same net effect Pi
  // produces — a grant here would WIDEN past what the agent's author declared.
  const tools = descriptor.tools && denied
    ? [...descriptor.tools].filter(tool => matchesToolPattern(
      parseSkillToolEntry(tool).name,
      [...denied],
      'skill disallowedTools',
    ) === null)
    : descriptor.tools ? [...descriptor.tools] : undefined;
  // AN EMPTIED GRANT IS NOT A REFUSAL, and an earlier version of this file made
  // it one. Recorded because the mistake is the recurring shape on this plan —
  // a row written to close a gap instead making the runtime STRICTER than the
  // one it was catching up to.
  //
  // Claude launches. `errors.md` § *Agent would be spawned with zero tools*,
  // fetched raw 2026-08-16, one sentence after the paragraph that was quoted in
  // support of refusing: "Omitting the `tools` field never triggers this
  // refusal. If you leave the `tools` list empty, or `disallowedTools` removes
  // every entry in it, Claude Code also skips the refusal and launches the
  // subagent without tools." A skill emptying the grant is exactly that case.
  // The page's refusal is for UNRESOLVABLE entries — a typo, a tool subagents
  // cannot use — which is a different cause with the same end state.
  //
  // Pi admits it too. Its `canonicalizeRuntimeSkillToolGrants` throw (`Child session agent
  // tool ceilings have an empty intersection`) sits UPSTREAM of the skill's
  // `disallowed-tools` removal and `invocations` is voided inside it, so a skill
  // cannot reach that throw; the removal runs afterwards at
  // `SessionManager`'s `narrowedGrantedTools` with no refusal behind it.
  //
  // So refusing here would withhold, on Claude only, an agent BOTH runtimes
  // admit — it can still reason and return text — and the model could not
  // delegate to it at all. R10 exists to remove a Claude-only degradation, not
  // to add one.
  const skillDenied = invocations
    .flatMap(invocation => [...(invocation.restrictions.disallowedTools ?? [])])
    .map(sdkDeniedToolName)
    .filter(name => name.length > 0);
  const disallowedTools = [...new Set([...(descriptor.disallowedTools ?? []), ...skillDenied])];
  return {
    // `SessionManager`'s own join: the agent's prompt first, then one block per
    // invoked skill, separated by a blank line.
    prompt: [
      descriptor.systemPrompt,
      ...invocations.map(invocation => formatRuntimeSkillInvocation(
        invocation,
        payload.renderedBodies?.get(invocation.key),
      )),
    ].join('\n\n'),
    ...(tools ? { tools } : {}),
    ...(disallowedTools.length ? { disallowedTools } : {}),
  };
}

/**
 * P3.345 — the roster half of cross-session messaging, unioned into a RESTRICTED
 * claude subagent's grant exactly as Pi already does it.
 *
 * `subagentRosterToolGrant` had one consumer, Pi's
 * `runtime-agent-definitions.ts`, and this builder forwarded the author's
 * `tools` verbatim — so the same descriptor produced a subagent that could write
 * to a peer on Pi and discover one, and on claude could only write. Both tools
 * are on claude's own surface (measured with `getSessionToolNames()`:
 * `list_sessions` true, `send_agent_message` true, the same-table control
 * `list_mcp_resources` false because it IS `pi-only`, and a fabricated name
 * false so the probe is reading the registry), so this is a UNION over names the
 * session already had, never a new capability.
 *
 * `cross-session-messaging.md`: "Claude uses two tools for this: `ListAgents` to
 * discover which agents it can reach, and `SendMessage` to deliver a message to
 * one of them by name." Two tools, one capability — which is the whole argument
 * for granting the second when the author declared the first.
 *
 * P6.19's three narrowings are all kept, and the third is enforced HERE because
 * the SDK cannot see our alias table:
 *
 * - only a name the parent pool carries — the grant filters
 *   `availableToolNames`, so a caller that passes none grants nothing;
 * - `list_sessions` is `readOnly` and workspace-scoped by its own handler;
 * - an explicit `disallowedTools` wins, under ANY accepted spelling. A denial
 *   written in the DOCUMENTED spelling (`ListAgents`) normalizes onto
 *   `list_sessions` through `PI_RUNTIME_AGENT_TOOL_ALIASES`, so an author who
 *   denied the tool by the name the page uses is honoured rather than
 *   overridden by a grant that only compared raw strings.
 *
 * SPELLING, stated rather than assumed: the granted name is whatever
 * `availableToolNames` carries, and the caller passes the session tools under
 * the same bare names the descriptor's own `tools` list uses — the descriptor is
 * one object shared by both runtimes and its author wrote `send_agent_message`,
 * not `mcp__session__send_agent_message`. So the roster half is spelled exactly
 * like the messaging half the author already declared: whatever the SDK does
 * with one, it does with the other, and the union cannot be weaker than the
 * status quo it replaces.
 *
 * No codex arm: `buildCodexAgentRoles` refuses any tool-declaring descriptor
 * outright and records why, so there is nothing there to widen.
 */
function rosterGrantForClaudeSubagent(
  declaredTools: readonly string[] | undefined,
  disallowedTools: readonly string[] | undefined,
  availableToolNames: readonly string[] | undefined,
): string[] {
  if (!availableToolNames?.length) return [];
  // An author who already listed the roster tool needs no grant, and a second
  // copy of the name in `tools` would be the only visible effect.
  if ((declaredTools ?? []).some(isSubagentRosterTool)) return [];
  const denied = new Set((disallowedTools ?? []).map(normalizePiRuntimeAgentToolName));
  return subagentRosterToolGrant(declaredTools, availableToolNames)
    .filter(name => !denied.has(normalizePiRuntimeAgentToolName(name)));
}

export function buildClaudeRuntimeAgents(
  definitions: readonly PiRuntimeAgentDefinitionDescriptor[] | undefined,
  modelPolicy?: ClaudeRuntimeAgentModelPolicy,
  skills?: ClaudeRuntimeAgentSkillInput,
  /** R12 — the USER-visible half. See {@link ClaudeRuntimeAgentNotice}. */
  onNotice?: (notice: ClaudeRuntimeAgentNotice) => void,
  /**
   * P3.345 — the session's own tool names, so the roster grant can only ever add
   * one the parent pool already carries. Absent means "the caller does not know
   * the pool", and the grant is then empty — never a guessed name.
   */
  availableToolNames?: readonly string[],
  /**
   * P6.791 (P6.342 (b)) — capability KEY → MCP WIRE NAME, from this turn's
   * capability view (`capabilities/views.ts`'s
   * {@link mcpWireNamesByCapabilityKey}). Absent means "the caller does not know
   * this session's wire names", and every declared key is then dropped and
   * announced exactly as before this row — the pre-P6.791 behaviour, byte for
   * byte.
   */
  mcpWireNamesByKey?: ReadonlyMap<string, string>,
  /**
   * F1.1203 — the environment `NESSY_CLAUDE_SETTING_SOURCES` is read from, the
   * same variable the session's own `settingSources` come from
   * ({@link claudeSessionLoadsProjectAgents}). A parameter only so a test can
   * name the list; production passes nothing.
   */
  env: Record<string, string | undefined> = process.env,
): Record<string, AgentDefinition> {
  // P3.277 — seeded with the bundled four, exactly as `loadAgentDefinitions`
  // seeds Pi's map before reading any runtime definition, and overwritable by a
  // same-named descriptor for the same reason that loader states ("Built-ins
  // have always been overwritable by a same-named user file, which is a
  // deliberate override").
  //
  // Gated on `definitions` being PRESENT rather than non-empty. `undefined` is
  // "this runtime does not dispatch agent definitions at all"
  // (`runtimeDispatchesAgentDefinitions` decides it one layer up), and seeding
  // builtins into a runtime that dispatches none would register four agents
  // whose Pi twins that session never had. An EMPTY array is the other case —
  // the session dispatches definitions and the user authored none — and there
  // the builtins are exactly what Pi would have.
  const agents: Record<string, SdkAgentDefinition> = definitions
    ? buildClaudeRuntimeBuiltinAgents(modelPolicy?.tierModelMap)
    : {};
  const announce = skills?.onDiagnostic ?? modelPolicy?.onDiagnostic;
  // P6.154 — and the sentence owed when the `small` tier could not be resolved,
  // on its OWN channel rather than the banner. Inside the same `definitions`
  // gate as the seeding above: a runtime that dispatches no definitions
  // registered no builtins, so it has no dropped tier to report.
  //
  // WHY NOT `announce`, measured rather than assumed. The row asked for a
  // "degradation line"; routed to the banner it fired on every gateway and BYO
  // session whose catalogue has no `fast` alias — which is most of them — and
  // broke SEVEN existing assertions across three suites, one of them named
  // "THE CONTROL — a turn with nothing degraded yields no banner at all".
  // That control is right and the row's wording was too strong: Pi drops the
  // same tier in the same arm and says nothing, so a banner here would
  // MANUFACTURE a user-visible divergence rather than close one. The fact is
  // still recorded, on a channel whose grade matches what it is — diagnostic
  // context, not a degradation — and a user-visible line that fires on BOTH
  // runtimes is an owner's call, not this row's.
  if (definitions) {
    for (const line of claudeBuiltinAgentTierDiagnostics(modelPolicy?.tierModelMap)) {
      modelPolicy?.onTierNotice?.(line);
    }
  }
  const projectAgentsLoadNatively = claudeSessionLoadsProjectAgents(env);
  for (const descriptor of definitions ?? []) {
    // F1.1178 — the host's copy of a trusted project's `.claude/agents` file
    // (F1.730, for Pi) is not registered here: the SDK loads that file itself,
    // with its frontmatter hooks and inline MCP servers, under the same
    // `settingSources` the session passes, and an entry of the same name in
    // `agents` would REPLACE that load with this translation, which carries
    // neither (the `componentHooks` notice and the P6.792 note below). Skipped
    // before anything is announced, since nothing of ours is degraded.
    if (isClaudeProjectAgentCopyKey(descriptor.key)) {
      // F1.1203 — and a file Claude loads under one of the bundled four's names
      // takes that name over, as a project agent named like a built-in does
      // (`sub-agents.md`, Built-in subagents: "A user or project subagent named
      // `Explore` overrides the built-in"). The bundled seed is PROGRAMMATIC and
      // outranks the file's load, so the seed gives way. The name is Claude's own
      // (the frontmatter `name`, {@link PiRuntimeAgentDefinitionDescriptor.claudeAgentName}),
      // never the file name; and only while the session loads project agents.
      const takenOver = projectAgentsLoadNatively ? descriptor.claudeAgentName : undefined;
      if (takenOver && RESERVED_AGENT_NAMES.has(takenOver)) delete agents[takenOver];
      continue;
    }
    const effort = descriptor.effort && SDK_EFFORT_LEVELS.has(descriptor.effort)
      ? descriptor.effort as Exclude<AgentDefinition['effort'], number | undefined>
      : undefined;
    const permissionMode = descriptor.permissionMode && SDK_PERMISSION_MODES.has(descriptor.permissionMode)
      ? descriptor.permissionMode as NonNullable<AgentDefinition['permissionMode']>
      : undefined;
    const model = resolvedModelField(descriptor, modelPolicy);
    // R10. `skills` absent is the pre-wiring state, and it is announced rather
    // than left silent: this row exists because the same agent is quietly
    // weaker on this runtime, so the un-materialized case must say so too.
    const payload = skills?.byAgentKey.get(descriptor.key);
    if (descriptor.skillKeys?.length && !payload) {
      announce?.(
        `Imported agent ${descriptor.key} declares ${descriptor.skillKeys.length} skill(s), `
        + 'which this turn did not materialize; the agent runs without them',
      );
    }
    // The ceiling compares against the model the agent will ACTUALLY run: the
    // declared one when the connection serves it, the session's otherwise —
    // which is exactly what `resolvedModelField` returning `{}` means.
    const withSkills = skills && payload
      ? applyAgentSkills(descriptor, payload, model.model ?? skills.sessionModel)
      : undefined;
    if (withSkills && 'refusal' in withSkills) {
      announce?.(
        `Imported agent ${descriptor.key} is unavailable this turn: ${withSkills.refusal}`,
      );
      continue;
    }
    const effectiveTools = withSkills?.tools ?? descriptor.tools;
    const effectiveDisallowedTools = withSkills?.disallowedTools ?? descriptor.disallowedTools;
    // P3.345 — read off the EFFECTIVE lists, not the descriptor's, so a skill
    // that removed the messaging tool (R10 narrows `tools`) or added a denial
    // takes the roster grant with it. Same order Pi applies: the grant is a
    // union over what survives the narrowing, never over what was declared
    // before it.
    const rosterGrant = rosterGrantForClaudeSubagent(
      effectiveTools,
      effectiveDisallowedTools,
      availableToolNames,
    );
    const grantedTools = effectiveTools
      ? [...effectiveTools, ...rosterGrant]
      : effectiveTools;
    // R12, the half that cannot be carried. Raised only for an agent that is
    // actually REGISTERED — an agent withheld above already announced its own
    // reason, and a second banner about the hooks of an agent that will not run
    // would name a consequence that does not exist.
    if (descriptor.componentHooks) {
      onNotice?.({
        agentKey: descriptor.key,
        definitionDigest: descriptor.definitionDigest,
        message: `Agent "${descriptor.name}" declares hooks in its definition. `
          + 'The Claude runtime runs the agent without them, so the commands they '
          + 'would have run around its work will not run.',
      });
    }
    // P6.342 (S) — the OTHER declaration this function used to drop, on the
    // same channel and under the same registered-only rule, because it was the
    // one difference between the two that was never a decision: `componentHooks`
    // was announced and `mcpServerKeys` was not, though both were dropped here
    // and Pi forwards this one (`orchestrator/runtime-agent-definitions.ts`,
    // `spawner.ts`). The SDK was NOT the obstacle — `AgentMcpServerSpec` is
    // `string | Record<string, McpServerConfigForProcessTransport>`; ours are
    // resolved capability KEYS, which are neither a configured server's name nor
    // a process-transport config, and mapping a key onto a name would hand the
    // child whatever server happened to answer to it.
    //
    // P6.790 / P6.792 — WHY THIS STILL HANDLES ONLY REFERENCES.
    //
    // `agents/definitions.ts` PARSES the inline form too and carries it as
    // `AgentDefinition.mcpServerInline` (P6.790 a), and
    // `PiRuntimeAgentDefinitionDescriptor.mcpServerInline` now exists as well
    // (`05cd7ef2d`) — this sentence said it did not until P6.791 corrected it.
    // Before that parse, an inline entry was DESTROYED at read time rather than
    // dropped: `- playwright:` became the bogus server name `"playwright:"`, and
    // every reference listed after it was lost with no diagnostic.
    //
    // What is missing is not the field, it is the GATE.
    // `sub-agents.md#scope-mcp-servers-to-a-subagent` loads an inline server
    // from a project agent file "only after you trust the folder the agent file
    // came from", and the descriptor carries `provenance` —
    // `` `${key}@${generation}` `` — with no path and no trust verdict beside
    // it. Forwarding an inline definition from here would therefore connect a
    // server this host cannot say was trusted, which is a strictly worse outcome
    // than not forwarding it. **P6.792 owns that input and the gate.**
    //
    // The digest-position rule that made the descriptor key safe to add is
    // pinned mechanically by `__tests__/claude-runtime-agents.test.ts` § "the
    // descriptor digest-position rule (P6.790)": every new key must be appended
    // LAST in BOTH literals that build a descriptor, or the two sides hash
    // differently and every definition carrying the key VANISHES FROM THE
    // SESSION with no exception and no diagnostic — and the two sides only
    // disagree for a definition that POPULATES the key, so a fixture leaving it
    // unset stays green.
    //
    // P6.791 (the M half's split b) — AND THE TRANSLATION NOW EXISTS, so the
    // notice covers only what is left. `mcpWireNamesByKey` is this turn's
    // capability view reduced to key → wire name; a key it resolves is
    // forwarded as the documented REFERENCE form and is no longer a drop.
    const declaredMcpKeys = descriptor.mcpServerKeys ?? [];
    const resolvedMcpNames: string[] = [];
    const unresolvedMcpKeys: string[] = [];
    for (const key of declaredMcpKeys) {
      const wireName = mcpWireNamesByKey?.get(key);
      // A duplicate would name the same server twice in one list; the SDK's
      // field is a set in meaning even though it is an array in shape.
      if (wireName) { if (!resolvedMcpNames.includes(wireName)) resolvedMcpNames.push(wireName); }
      else unresolvedMcpKeys.push(key);
    }
    if (unresolvedMcpKeys.length) {
      onNotice?.({
        agentKey: descriptor.key,
        definitionDigest: descriptor.definitionDigest,
        message: `Agent "${descriptor.name}" declares ${unresolvedMcpKeys.length} MCP `
          + `server${unresolvedMcpKeys.length === 1 ? '' : 's'} in its definition `
          + `this session cannot name (${unresolvedMcpKeys.join(', ')}). The `
          + "Claude runtime registers the agent without that declaration, so it works with this "
          + 'session\'s own servers instead of the set it named; on the Pi runtime the same '
          + 'definition gets exactly the servers it declared.',
      });
    }
    agents[agentNameOf(descriptor)] = {
      // Required by the type, and the field the model matches a task against:
      // an empty one makes the agent undelegatable. Same fallback string the Pi
      // side substitutes (`runtime-agent-definitions.ts:352`).
      description: descriptor.description || `Imported ${descriptor.name} agent.`,
      // R10: the agent's own prompt, plus one `<invoked-skill>` block per skill
      // it declares — the same content, in the same order, that Pi's child
      // session receives.
      prompt: withSkills?.prompt ?? descriptor.systemPrompt,
      // Verbatim. The descriptor carries the AUTHOR's list
      // (`buildPiRuntimeAgentDescriptor`: `tools: [...tools]`), never the
      // Pi-normalized one, so these are already Claude's own spellings — which
      // is what `AgentDefinition.tools` wants. Rewriting `Agent` to Pi's
      // `subagent` here would name a tool the SDK does not have.
      //
      // R10 narrows both lists when an inlined skill declares
      // `disallowed-tools`: an entry the skill removes is dropped from the
      // grant AND named in the denial, so the removal holds for an agent that
      // declares no `tools` at all and therefore inherits everything.
      //
      // P3.345 unions the roster half onto this list when the author declared
      // the messaging half; `rosterGrantForClaudeSubagent` carries the reason and
      // the three narrowings. An agent with NO `tools` list inherits the parent
      // pool and already had both, so the union is skipped there rather than
      // turning an unrestricted agent into a restricted one.
      //
      // P6.836 — AND THE RUNTIME NARROWS THIS LIST AGAIN, AFTER US. What is
      // forwarded here is a request, not the pool the subagent gets.
      // `sub-agents.md#available-tools`, verbatim: "Subagents inherit the
      // built-in tools and MCP tools available in the main conversation,
      // narrowed by two filters: the first removes a short list of tools from
      // every subagent, and the second reduces the built-in tool set for
      // subagents that run in the background, which is the default." The first
      // filter's own lead-in is the load-bearing half — "The first filter
      // removes these tools, even when listed in the `tools` field" — so
      // naming a tool here does not make it reachable.
      //
      // The first filter (EVERY subagent) removes `Agent` at the depth limit,
      // `AskUserQuestion`, `EndConversation`, `EnterPlanMode`, `ExitPlanMode`
      // (unless `permissionMode` is `plan`), `ScheduleWakeup`, `TaskOutput`,
      // `WaitForMcpServers` and `Workflow`. The page names the task and cron
      // tools only obliquely, through its teammates carve-out ("Teammates in
      // agent teams additionally keep the task tools and cron tools:
      // `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `CronCreate`,
      // `CronDelete`, and `CronList`"), which is a statement that an ordinary
      // subagent does not keep them.
      //
      // Measured on the vendored child (2.1.233) by W9-aj, a FOREGROUND
      // subagent's list against the main turn's: it loses `CronCreate`,
      // `CronDelete`, `CronList`, `TaskCreate`, `TaskGet`, `TaskList`,
      // `TaskOutput`, `TaskUpdate`, `Workflow`, `ReportFindings` and
      // `ScheduleWakeup`, and keeps every MCP tool. `ReportFindings` is in the
      // measurement and in NONE of the page's lists, so the removed set is read
      // from the runtime, not derived from the prose.
      //
      // Two consequences for this file. Anything this fork forwards that
      // assumes a scheduling or workflow tool is reachable inside a subagent
      // assumes something the runtime removes — the grant is silently smaller,
      // and the removal "reports no error unless it leaves the `tools` list
      // resolving to nothing". And `background` is forwarded just below:
      // it selects the SECOND filter, which cuts the built-in set down to a
      // fixed list, so the same descriptor resolves to different tools in the
      // foreground and the background. Nothing is corrected here on purpose —
      // pre-filtering our own list would hide the runtime's rule behind a
      // second one and would go stale the next time that list moves.
      ...(grantedTools ? { tools: [...grantedTools] } : {}),
      ...(effectiveDisallowedTools ? { disallowedTools: [...effectiveDisallowedTools] } : {}),
      // Unresolved pass-through for anthropic upstreams (`sdk.d.ts:56` alias
      // semantics); substituted-with-a-diagnostic when the caller knows the
      // served catalog — see resolvedModelField for the live measurement that
      // narrowed the old blanket pass-through.
      ...model,
      ...(descriptor.maxTurns === undefined ? {} : { maxTurns: descriptor.maxTurns }),
      ...(descriptor.background === undefined ? {} : { background: descriptor.background }),
      ...(effort ? { effort } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(descriptor.memory ? { memory: descriptor.memory } : {}),
      // R12 — the author's explicit "give me my own copy of the repository".
      // `sub-agents.md:262`: "A subagent starts in the main conversation's
      // current working directory. … To give the subagent an isolated copy of
      // the repository instead, set `isolation: worktree`." Dropped before this
      // row, so an agent whose author said "not in the user's checkout" wrote
      // into the user's checkout, and nothing said so.
      //
      // Only the DECLARATION is forwarded. Pi additionally isolates any agent
      // whose declared tools are not read-only (`piRuntimeAgentWorktreePolicy`),
      // and that default is deliberately NOT mirrored here: it is Pi's own
      // hardening, Claude's documented baseline is the parent's working
      // directory, and "Claude runs as-is" is the rule this file opens with.
      // Measured on one descriptor (`tools: [Read, Grep]`): Pi answers
      // `isolated-worktree` with the declaration and `shared` without it, so
      // the declaration is the load-bearing input on both runtimes.
      ...(descriptor.isolation ? { isolation: descriptor.isolation } : {}),
      // P6.791 — the author's declared servers, as NAMES this session actually
      // configured. `sub-agents.md#scope-mcp-servers-to-a-subagent`, verbatim:
      // "Each entry in the list is either an inline server definition or a
      // string referencing an MCP server already configured in your session",
      // and "String references share the parent session's connection." So the
      // reference form needs no transport config and — by the same page's
      // trust rules, which list "A name that references a server you already
      // configured" among the two kinds loaded WITHOUT a folder-trust check —
      // no trust gate either. That gate belongs to the INLINE form, which this
      // function still does not carry (P6.792).
      //
      // Only wire names the capability view resolved are here: an unresolved
      // key is announced above and never sent, because sending a key as a name
      // is precisely what would hand the child whatever server answered to it.
      //
      // P6.832 — MEASURED, because neither side documents it: the field is
      // ADDITIVE, never restrictive. `sdk.d.ts:59` types `mcpServers` with no
      // doc comment at all (its neighbour `tools` states its inheritance rule
      // outright), and the page frames the field additively without saying what
      // becomes of the session's OTHER servers when the list is present. Under a
      // restrictive reading this forwarding would be a NARROWING: an author who
      // names one server to add it would silently strip every other server the
      // session configured out of that subagent's reach.
      //
      // One turn on the vendored child (2.1.233 / agent-sdk 0.3.233, from its own
      // `user-agent`), two session MCP servers, the subagent's request body read
      // off a scripted stub upstream — no model, no credential; the rig is
      // `__tests__/fixtures/claude-subagent-mcp-scope-probe.ts`:
      //
      //   no `mcpServers` field   → subagent offered alpha + beta
      //   `mcpServers: ['alpha']` → subagent offered alpha + beta  (unchanged)
      //   inline `gamma` only     → subagent offered alpha + beta + GAMMA,
      //                             while the main turn kept alpha + beta
      //
      // The inline arm is what separates "additive" from "the field was ignored":
      // a string reference names a server the subagent inherits anyway, so those
      // two arms alone cannot tell them apart. It also confirms
      // `sub-agents.md#available-tools`, verbatim: "Subagents inherit the
      // built-in tools and MCP tools available in the main conversation, narrowed
      // by two filters" — and this field is neither filter. Narrowing a
      // subagent's MCP reach is `tools`/`disallowedTools`' job, not this one.
      //
      // Consequence for the line below: forwarding a resolved name can only widen
      // or no-op, never take a server away — and for a server the session already
      // configured it is exactly a no-op for REACHABILITY, since the subagent
      // inherits it either way. It is still sent, because it is the author's
      // declaration and the documented reference form; what would make it
      // load-bearing is the INLINE form (P6.792), which this function still does
      // not carry.
      ...(resolvedMcpNames.length ? { mcpServers: [...resolvedMcpNames] } : {}),
    };
  }
  return agents;
}

/**
 * The exact fragment a Claude turn spreads into its `query()` options — the
 * seam `claude-agent.ts` calls and the seam the tests assert, so the builder
 * above cannot be correct in a code path no turn reaches (Q6-D4 was that defect
 * one layer up: the definitions existed and reached nothing).
 *
 * Mirrors `buildClaudeStructuredOutputOptions`: a pure `Pick<Options, …>` whose
 * absent case is `{}` rather than an explicit `undefined`.
 *
 * Two gates, both deliberate:
 *
 * - `mini` withholds them. That branch exists to cut the token count with a
 *   lean prompt and a minimal tool list, and it never delegates.
 * - an empty record is omitted ENTIRELY rather than sent as `agents: {}`, so a
 *   session with no definitions keeps the SDK's own built-in set
 *   (`general-purpose`, `Explore`, `Plan`, …) exactly as the runtime ships it.
 *   Sending our set is additive by the same contract:
 *   `agent-sdk/subagents.md:738` — "**A programmatic agent with the same name**:
 *   `agents` passed to `query()` override a filesystem agent with the same
 *   name."
 */
export function buildClaudeRuntimeAgentOptions(input: {
  definitions: readonly PiRuntimeAgentDefinitionDescriptor[] | undefined;
  mini: boolean;
  modelPolicy?: ClaudeRuntimeAgentModelPolicy;
  /**
   * R10 — the agents' skills, already materialized by
   * {@link materializeClaudeRuntimeAgentSkills}. Absent means no agent gets its
   * skill bodies and each skill-declaring agent announces that on the diagnostic
   * channel; it is not a silent state.
   */
  skills?: ClaudeRuntimeAgentSkillInput;
  /**
   * R12 — one notice per registered agent this runtime degrades. Fires only on
   * the branch that actually sends agents: the `mini` return below is ahead of
   * the builder, so a lean internal completion raises no banner about agents it
   * never registered.
   */
  onNotice?: (notice: ClaudeRuntimeAgentNotice) => void;
  /**
   * P3.345 — the session's own tool names, threaded from the turn so the roster
   * grant can only add a name this session actually has. Optional: a caller that
   * omits it keeps the pre-P3.345 behaviour exactly.
   */
  availableToolNames?: readonly string[];
  /**
   * P6.791 (P6.342 (b)) — this turn's capability KEY → MCP WIRE NAME map, the
   * one input this seam never had. Build it with
   * `mcpWireNamesByCapabilityKey(capabilityRuntime.view)`; omitting it keeps the
   * pre-P6.791 behaviour exactly, which is what a turn with no pinned capability
   * view gets.
   */
  mcpWireNamesByKey?: ReadonlyMap<string, string>;
  /**
   * P6.312 — the agent this SESSION runs as, not one it can delegate to. See
   * {@link pinClaudeMainThreadAgent} for what is pinned, what is withheld and
   * why the withholding is announced. Absent (the default, and every session
   * that has not set the host key) leaves the option set byte-identical to what
   * it was before the row.
   */
  mainThreadAgent?: string;
  /**
   * Where the main-thread pin says what it could not do. Absent means the
   * caller does not offer a channel, and the pin then still applies — the
   * withholding is a fact about the session either way, and silently declining
   * to pin would be worse than pinning without the sentence.
   */
  onDiagnostic?: (message: string) => void;
  /** F1.1203 — passed through to {@link buildClaudeRuntimeAgents}'s `env`; production passes nothing. */
  env?: Record<string, string | undefined>;
}): Pick<Options, 'agents' | 'agent'> {
  if (input.mini) return {};
  const agents = buildClaudeRuntimeAgents(
    input.definitions,
    input.modelPolicy,
    input.skills,
    input.onNotice,
    input.availableToolNames,
    input.mcpWireNamesByKey,
    input.env,
  );
  if (!Object.keys(agents).length) {
    // P6.312 — a pin with no roster to name cannot be honoured, and saying so is
    // the whole difference between this and the silence the row was written
    // against. `agent` is NOT sent: the SDK requires the name to be defined in
    // `agents` or in settings, and sending an unresolvable one is how a session
    // dies at spawn instead of degrading.
    //
    // F1.1203 — with `definitions` present the record is empty only when the
    // project's `.claude/agents` files took over all four bundled names: Claude
    // then has those agents from the files, so "no agent definitions at all"
    // would be false. The pin still is not sent (the F1.1178 residue).
    if (input.mainThreadAgent) {
      input.onDiagnostic?.(
        `Session agent "${input.mainThreadAgent}" was not applied: `
        + (input.definitions === undefined
          ? 'this session registers no agent definitions at all.'
          : "the project's .claude/agents files, which Claude loads itself, took over all four"
            + ' bundled agent names, so this session registers no agent definitions of its own to pin.'),
      );
    }
    return {};
  }
  return {
    agents,
    ...pinClaudeMainThreadAgent(agents, input.mainThreadAgent, input.onDiagnostic),
  };
}

/**
 * P6.312 — pin the session's MAIN THREAD to one of the agents it registered.
 *
 * ## Native, and the sentence is the contract
 *
 * `Options.agent` (vendored `sdk.d.ts`): *"Agent name for the main thread. When
 * specified, the agent's system prompt, tool restrictions, and model will be
 * applied to the main conversation. The agent must be defined either in the
 * `agents` option or in settings."* And `AgentDefinition.initialPrompt`:
 * *"Auto-submitted as the first user turn when this agent is the main thread
 * agent. Slash commands are processed. Prepended to any user-provided prompt."*
 *
 * So on this runtime the prompt, the tools and the one-shot `initialPrompt` are
 * the SDK's own work and this function builds nothing for them. What it owes is
 * the name, the resolution, and the ONE half the host withholds.
 *
 * ## The model is withheld, and it is withheld LOUDLY
 *
 * Owner decision 2026-09-07, option (b): the agent's prompt, tools and
 * `initialPrompt` are pinned and the SESSION'S UPSTREAM STAYS. The SDK's own
 * sentence would apply the agent's model to the main conversation, which gives
 * one session two answers to "what model is this?" — the connection's, which
 * every other surface in this host reports, and the agent's, which only the
 * child would know. That is ledger K7's *one session equals one upstream*
 * demotion, and it is why this deletes `model` from the PINNED entry.
 *
 * DELETED FROM THE REGISTRATION, not filtered at some later gate, because the
 * registration is the only place the SDK reads it from — and the same entry is
 * what a subagent dispatch of that name would use, so the withholding is one
 * fact about the whole session rather than two behaviours under one name.
 *
 * ## An unknown name degrades; it never dies
 *
 * A name the roster does not carry is announced and NOT sent. The SDK requires
 * the name to resolve, so sending an unresolvable one turns a mistyped setting
 * into a session that will not start — the opposite of what a host-side pin is
 * for.
 */
export function pinClaudeMainThreadAgent(
  agents: Record<string, SdkAgentDefinition>,
  name: string | undefined,
  onDiagnostic?: (message: string) => void,
): Pick<Options, 'agent'> {
  if (!name) return {};
  const pinned = agents[name];
  if (!pinned) {
    onDiagnostic?.(
      `Session agent "${name}" was not applied: this session registers no agent by that name`
      + ` (it has ${Object.keys(agents).sort().join(', ')}).`,
    );
    return {};
  }
  if (pinned.model !== undefined) {
    const declared = pinned.model;
    delete pinned.model;
    onDiagnostic?.(
      `Session agent "${name}" declares model "${declared}"; this session keeps its own model.`
      + ' An agent running as the main thread does not re-point the connection.',
    );
  }
  return { agent: name };
}

/**
 * F1.1203 — whether this session's Claude child loads `.claude/agents` itself:
 * `settingSources` with `project` in it, which is the documented default
 * (`resolveClaudeSettingSources` answers `undefined`) unless the operator's
 * `NESSY_CLAUDE_SETTING_SOURCES` leaves it out. Trust is not re-checked here:
 * the inventory mints a `.claude/agents` copy only for a trusted project, and a
 * trusted project's list is the resolver's unchanged
 * (`claudeSettingSourcesForProjectTrust` in `claude-agent.ts`).
 */
function claudeSessionLoadsProjectAgents(env: Record<string, string | undefined>): boolean {
  const sources = resolveClaudeSettingSources(env);
  return sources === undefined || sources.includes('project');
}

// F1.1203 — imported at the end so no line the docs cite by number moves.
import { resolveClaudeSettingSources } from '../config/claude-flag-settings.ts';

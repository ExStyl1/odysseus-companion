import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import type { CapabilitySnapshotMaterializer } from './materializer.ts';
import type { RuntimeSkillHandle } from './views.ts';
import { pluginRuntimeEnvForProfile } from '../plugins/data-paths.ts';
import { splitMarkdownFrontmatter, splitToolGrantList } from '../plugins/format-adapters/shared.ts';
import { parseRuntimeSkillContextCommands } from './runtime-skill-context.ts';
import { mergeAutomationsConfigs, parseHooksConfigContent } from '../automations/hooks-config.ts';
import type { AutomationsConfig, ComponentHookLayer, AgentEvent as AutomationAgentEvent } from '../automations/types.ts';

const MAX_SKILL_BODY_BYTES = 256 * 1024;
const MAX_SUPPORTING_RESOURCES = 16;
const MAX_SUPPORTING_RESOURCE_BYTES = 32 * 1024;
// 25k estimated tokens × 4 UTF-16 code units/token × 6 JSON bytes/unit = 600k body bytes;
// 1 MiB adds bounded headroom for the serialized snapshot and envelope metadata.
export const MAX_REATTACHED_SKILL_PERSISTENCE_BYTES = 1024 * 1024;
export const MAX_SKILL_INVOCATION_BYTES = MAX_REATTACHED_SKILL_PERSISTENCE_BYTES;
const SECRET_TEXT = /(?:\bbearer\s+[a-z0-9._~+/=-]{8,}|\bsk-[a-z0-9_-]{8,}|\bgh[opusr]_[a-z0-9]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;

export interface SkillSupportingResourceSnapshot {
  handle: string;
  digest: string;
  /**
   * The reference's path relative to the skill's own directory — the same value
   * `CapabilitySnapshotMaterializer.readRelativeText` takes, so a resolver can
   * re-read the file through the containment check instead of opening a path of
   * its own. Optional only for back-compat: a record persisted before R17 has
   * none, and such a record cannot be resolved (there is nothing to re-verify
   * against) rather than being resolved unchecked.
   */
  relativePath?: string;
  content: string;
}

/**
 * The `context: fork` dispatch descriptor — present ONLY on a skill whose
 * frontmatter says `context: fork` (`skills.md:267`, "Set to `fork` to run in a
 * forked subagent context").
 *
 * `skills.md:569` is the sentence that decides what this is and what it is not:
 * "Add `context: fork` to your frontmatter when you want a skill to run in
 * isolation. The skill content becomes the prompt that drives the subagent. It
 * won't have access to your conversation history." So this is NOT the `/subtask`
 * conversation fork, which exists precisely to inherit that history — it is an
 * ordinary NAMED-subagent spawn whose task is the skill body.
 *
 * `agent` is the documented fork target (`:268`, "Which subagent type to use
 * when `context: fork` is set"). It is deliberately kept OUT of
 * `restrictions.agent`: that field is a ceiling on which subagents the INVOKING
 * turn may spawn, and reusing it here would either change every non-forked
 * skill's ceiling semantics or narrow a parent turn on behalf of content that
 * never enters it.
 */
export interface SkillForkDispatch {
  /**
   * The named subagent type whose system prompt drives the fork, or absent for
   * the host default. `fork` itself is refused at dispatch: a skill fork must
   * not inherit the conversation.
   */
  readonly agent?: string;
  /**
   * `skills.md:265`, the `model` row's last sentence: "With `context: fork`, the
   * value sets the forked subagent's model instead, and an excluded value
   * follows the same rules as a subagent model override."
   *
   * So `model` moves here for the same reason `agent` does. Leaving it in
   * `restrictions.model` would have it checked against the INVOKING session's
   * model and fail the turn (`Invoked skill model unavailable`) for a skill the
   * page says should simply run its child on that model; dropping it instead
   * would be a parsed-and-never-read field.
   */
  readonly model?: string;
  /**
   * `skills.md:269` — "Only applies with `context: fork`. Set to `false` to wait
   * for the forked subagent's result in the turn that invoked the skill …
   * Default: `true`."
   */
  readonly background: boolean;
}

export interface SkillInvocationRecord {
  key: string;
  name: string;
  sourceDigest: string;
  invocationDigest: string;
  generation: string;
  invokedAt: number;
  body: string;
  supportingResources: readonly SkillSupportingResourceSnapshot[];
  restrictions: {
    /**
     * `allowed-tools` — "Tools Claude can use without asking permission during
     * the turn that invokes this skill" (`skills.md`, frontmatter table). A
     * PRE-APPROVAL, despite the field's home under `restrictions`: it never
     * removes a tool, and an unlisted tool stays callable under the session's
     * ordinary permission flow. `disallowedTools` below is the half that
     * restricts.
     */
    tools?: readonly string[];
    model?: string;
    agent?: string;
    /** A documented `effort` level (`skills.md:262`), or absent for "inherit". */
    effort?: string;
    /**
     * `disallowed-tools` — "Tools removed from Claude's available pool while
     * this skill is active" (`skills.md:262`, `:430`). Subtraction, not
     * narrowing: it applies whether or not the skill also declares
     * `allowed-tools`, and it outranks a grant that names the same tool.
     */
    disallowedTools?: readonly string[];
    /**
     * {@link SkillForkDispatch}, appended LAST and only when the author wrote
     * `context: fork`. A record without it keeps exactly the key set — and
     * therefore the digest JSON — it had before this field existed, so every
     * snapshot persisted earlier still restores.
     */
    fork?: SkillForkDispatch;
  };
  states: {
    available: true;
    selected: true;
    resourceLoaded: boolean;
    grantApplied: true;
  };
  /**
   * R87 — the skill's frontmatter `hooks` block, parsed into the same
   * `AutomationsConfig` shape settings hooks use (`hooks.md` § Hooks in skills
   * and agents: "the same configuration format as settings-based hooks").
   * Present ONLY when the frontmatter declared runnable hooks, and appended LAST
   * so a record without it keeps exactly the key set — and therefore the digest
   * JSON — it had before this field existed, the same rule `fork` follows.
   *
   * Split by `once`: {@link SkillComponentHooks}. The layer that dispatches
   * these (`BaseAgent.getComponentHookLayer`) reads the LIVE active-invocation
   * set at dispatch time, which is what scopes them to the skill's lifetime.
   */
  componentHooks?: SkillComponentHooks;
}

/**
 * A skill's frontmatter hooks, partitioned by the `once` field.
 *
 * `hooks.md`, the `once` field: "If `true`, runs once per session then is
 * removed. Only honored for hooks declared in skill frontmatter; ignored in
 * settings files and agent frontmatter." Keeping the two tiers apart is what
 * lets a consumed once-hook be dropped without disturbing the hooks that keep
 * firing while the skill stays active.
 */
export interface SkillComponentHooks {
  /** Hooks that fire on every matching event while the skill is active. */
  readonly always?: AutomationsConfig;
  /** `once: true` hooks — run once per session, then removed. */
  readonly once?: AutomationsConfig;
}

type UnsignedSkillInvocationRecord = Omit<SkillInvocationRecord, 'invocationDigest'>;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeSnapshotText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`Invalid skill invocation ${field}`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`Skill invocation ${field} exceeds ${maxBytes} bytes`);
  }
  if (SECRET_TEXT.test(value)) throw new Error(`Skill invocation ${field} must not contain a secret`);
  return value;
}

function boundedIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid skill invocation ${field}`);
  }
  return value;
}

/**
 * A supporting resource's relative path, re-checked on the way back in from a
 * persisted snapshot. Same shape `supportingReferences` admits: skill-relative,
 * normalized, never absolute, never escaping, never a backslash or NUL path.
 * Containment is still enforced downstream by `resolveContainedPath`; this is
 * the cheap fail-closed check that keeps an escaping path out of the snapshot in
 * the first place.
 */
function safeSupportingResourcePath(value: unknown): string {
  const path = boundedIdentity(value, 'supporting resource path');
  if (path.includes('\\') || path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)) {
    throw new Error('Invalid skill supporting resource path');
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || !normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Invalid skill supporting resource path');
  }
  return normalized;
}

/**
 * The host-supplied skill variables, each in both spellings.
 *
 * We emit the Nessy name and keep the Claude name as a compatibility alias, the
 * same split `claudeCompatPluginEnv` (`plugins/data-paths.ts`) makes for
 * `NESSY_PROJECT_DIR` / `CLAUDE_PROJECT_DIR`.
 *
 * - `SKILL_DIR` — `skills.md:300`, "the directory containing the skill's
 *   `SKILL.md` file. For plugin skills, this is the skill's subdirectory within
 *   the plugin, not the plugin root."
 * - `SESSION_ID` — `:298`, "the current session ID. Useful for logging, creating
 *   session-specific files, or correlating skill output with sessions."
 * - `EFFORT` — `:299`, "the current effort level: `low`, `medium`, `high`,
 *   `xhigh`, or `max`."
 * - `PROJECT_DIR` — `:307`, "The project root directory. This is the same path
 *   hooks and MCP servers receive as `CLAUDE_PROJECT_DIR`. Use this to reference
 *   project-local scripts or files, such as
 *   `${CLAUDE_PROJECT_DIR}/.claude/hooks/helper.sh`, independent of where the
 *   skill is installed." Defined for EVERY skill origin, not only a plugin's:
 *   the plugin-env pass reaches `${CLAUDE_PROJECT_DIR}` for a
 *   `claude-plugin-env-v1` bundle alone, and `:307` is a skill-level contract.
 *
 * Every value is HOST-DERIVED. `process.env` is never consulted, and a value the
 * host cannot supply leaves its variable literal rather than expanding to
 * something wrong — the R17 rule, unchanged.
 */
const SKILL_VARIABLE_SPELLINGS = {
  skillDirectory: ['NESSY_SKILL_DIR', 'CLAUDE_SKILL_DIR'],
  sessionId: ['NESSY_SESSION_ID', 'CLAUDE_SESSION_ID'],
  effort: ['NESSY_EFFORT', 'CLAUDE_EFFORT'],
  projectDirectory: ['NESSY_PROJECT_DIR', 'CLAUDE_PROJECT_DIR'],
} as const;

/** Host-derived values for {@link SKILL_VARIABLE_SPELLINGS}. */
export interface RuntimeSkillHostContext {
  /** The session the skill is being invoked in. */
  sessionId?: string;
  /** The effort level in force for the invoking turn. */
  effort?: string;
  /**
   * The active project root — `context.projectRoot ?? context.workingDirectory`,
   * the same value the plugin runtime binds as `projectPath`. A plugin skill's
   * own binding still wins (see {@link skillProjectDirectory}) so the two passes
   * cannot disagree about where the project is.
   */
  projectDirectory?: string;
}

type SkillVariableValues = Partial<Record<keyof typeof SKILL_VARIABLE_SPELLINGS, string>>;

/**
 * Substitute the host variables, and ONLY them.
 *
 * Unknown variables are untouched here and stay literal downstream. Callers
 * choose WHICH variables they pass: `skills.md:309` — "Claude Code substitutes
 * `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` in two places: the skill's
 * markdown content, and Bash rules in the `allowed-tools` frontmatter" — names
 * exactly TWO variables for the restriction site, so the restriction path passes
 * those two and a `${CLAUDE_SESSION_ID}` inside a security rule stays a variable.
 */
function expandSkillVariables(text: string, values: SkillVariableValues): string {
  let expanded = text;
  for (const [key, spellings] of Object.entries(SKILL_VARIABLE_SPELLINGS)) {
    const value = values[key as keyof SkillVariableValues];
    if (value === undefined || value === '') continue;
    for (const name of spellings) {
      expanded = expanded.split(`\${${name}}`).join(value);
      expanded = expanded.replace(new RegExp(`\\$${name}(?![A-Za-z0-9_])`, 'g'), () => value);
    }
  }
  return expanded;
}

/** The two variables `skills.md:309` substitutes in an `allowed-tools` rule. */
export interface SkillRestrictionVariables {
  skillDirectory?: string;
  projectDirectory?: string;
}

/** Expand ONLY the two variables a security rule may carry (`skills.md:309`). */
function expandRestrictionVariables(text: string, variables: SkillRestrictionVariables): string {
  return expandSkillVariables(text, {
    ...(variables.skillDirectory ? { skillDirectory: variables.skillDirectory } : {}),
    ...(variables.projectDirectory ? { projectDirectory: variables.projectDirectory } : {}),
  });
}

/**
 * The value of `${CLAUDE_PROJECT_DIR}` for one skill.
 *
 * A plugin skill's server-validated `projectPath` wins over the host's, because
 * the plugin-env pass on the BODY already uses it: one resolved value for both
 * documented sites is the only way the rule and the command the body names stay
 * the same string, which is the entire point of the pair (`skills.md:321`).
 */
function skillProjectDirectory(
  skill: RuntimeSkillHandle,
  host: RuntimeSkillHostContext | undefined,
): string | undefined {
  return skill.pluginRuntime?.projectPath ?? host?.projectDirectory;
}

/**
 * `skills.md:262` — "Options: `low`, `medium`, `high`, `xhigh`, `max`; available
 * levels depend on the model."
 *
 * The five documented spellings and nothing else. `off` is a Nessy level the
 * field does not document, and `inherit` is the `model` field's keyword, not
 * this one — both land here as "no override", which is also this field's
 * documented default ("inherits from session").
 *
 * DEGRADES, never throws. An unrecognized level yields `undefined` and the
 * session keeps its own effort — the same shape `:261` gives an unavailable
 * model ("is not used and the session keeps its current model") and the same
 * shape `normalizeThinkingLevel` already uses for a bad persisted value. A skill
 * a user cannot invoke at all because they typed `xhi` would be a worse failure
 * than one that runs at the session's effort.
 */
export function skillEffortLevel(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && (['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(normalized as 'low')
    ? normalized
    : undefined;
}

/**
 * The restore-path half of {@link resolveRestriction}.
 *
 * A persisted value was already expanded at materialization, so nothing is
 * substituted here — and, like the materialize path, a surviving `$VAR` is kept
 * LITERAL rather than refused. It has to be: a record materialized with a
 * literal must restore, or a skill that merely mentions an unsupported variable
 * in its frontmatter becomes unresumable after a restart.
 */
function staticRestriction(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return boundedIdentity(value, field).trim();
}

/**
 * `skills.md:248` — "Boolean fields accept `yes`, `no`, `on`, `off`, `1`, and
 * `0` in any letter case, in addition to `true` and `false`."
 *
 * THE reader for every skill frontmatter boolean, on every path. It used to live
 * privately in `skills/storage.ts`; the `context: fork` dispatch needs the same
 * table for `background`, and a second hand-rolled copy is exactly the drift
 * that comment warned about — an unrecognised spelling reads as "not stated" and
 * silently takes the default, which for `disable-model-invocation` is a control
 * bypass and for `background` is the wrong dispatch mode.
 */
const SKILL_BOOLEAN_WORDS: Readonly<Record<string, boolean>> = Object.freeze({
  true: true, yes: true, on: true, 1: true,
  false: false, no: false, off: false, 0: false,
});

export function skillFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return SKILL_BOOLEAN_WORDS[String(value)];
  if (typeof value === 'string') return SKILL_BOOLEAN_WORDS[value.trim().toLowerCase()];
  return undefined;
}

/** Key ORDER is part of the snapshot contract — see {@link frozenUnsignedRecord}. */
function frozenSkillForkDispatch(fork: SkillForkDispatch): SkillForkDispatch {
  return Object.freeze({
    ...(fork.agent ? { agent: fork.agent } : {}),
    ...(fork.model ? { model: fork.model } : {}),
    background: fork.background,
  });
}

/**
 * `skills.md:267` — `context` is a closed field: `fork` is its only documented
 * value. Anything else is not a fork request and leaves the skill inline, which
 * is the safe degrade: an unrecognised value must never route a skill's content
 * away from the conversation that asked for it.
 */
function isSkillForkContext(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'fork';
}

/** Read on the RESTORE path — see {@link staticRestriction} for the same rule. */
function staticForkDispatch(value: unknown): SkillForkDispatch | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid skill invocation fork dispatch');
  }
  const input = value as Partial<SkillForkDispatch>;
  if (typeof input.background !== 'boolean') throw new Error('Invalid skill invocation fork dispatch');
  const agent = staticRestriction(input.agent, 'fork agent');
  const model = staticRestriction(input.model, 'fork model');
  return frozenSkillForkDispatch({
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    background: input.background,
  });
}

/**
 * THE predicate for "this invocation runs in a forked subagent instead of in
 * this conversation". One reader, because the three consumers (the user turn,
 * the model-invocation continuation, and the pinned-block formatter) must never
 * disagree about which invocations enter the transcript inline.
 */
export function isForkedSkillInvocation(invocation: SkillInvocationRecord): boolean {
  return invocation.restrictions.fork !== undefined;
}

function componentOnceKey(skillKey: string, event: string): string {
  return `${skillKey} ${event}`;
}

/**
 * Build the R87 component-hook layer over a LIVE view of the active skill
 * invocations (`hooks.md` § Hooks in skills and agents). Every method re-reads
 * `activeInvocations()` when called, which is exactly what scopes the hooks to
 * each skill's lifetime: a skill invoked mid-turn is seen and one whose record
 * has left the set is gone, with no rebuild of the automation system.
 *
 * `once` state lives in the caller-owned `consumed` set (keyed by skill+event),
 * so "runs once per session then is removed" holds across dispatches within a
 * session and resets when that set is cleared (`/clear`). Shared by
 * `BaseAgent.getComponentHookLayer` and its tests so the dispatched behaviour and
 * the tested behaviour are the same code.
 */
export function createComponentHookLayer(
  activeInvocations: () => Iterable<SkillInvocationRecord>,
  consumed: Set<string>,
): ComponentHookLayer {
  const configFor = (event: AutomationAgentEvent, tier: 'always' | 'once'): AutomationsConfig | undefined => {
    const configs: AutomationsConfig[] = [];
    for (const invocation of activeInvocations()) {
      if (tier === 'once' && consumed.has(componentOnceKey(invocation.key, event))) continue;
      const tierConfig = tier === 'always' ? invocation.componentHooks?.always : invocation.componentHooks?.once;
      const matchers = tierConfig?.automations[event];
      if (matchers && matchers.length > 0) configs.push({ automations: { [event]: matchers } });
    }
    if (configs.length === 0) return undefined;
    return configs.length === 1 ? configs[0]! : mergeAutomationsConfigs(...configs);
  };
  return {
    matchersFor: event => configFor(event, 'always'),
    onceMatchersFor: event => configFor(event, 'once'),
    consumeOnce: event => {
      for (const invocation of activeInvocations()) {
        const matchers = invocation.componentHooks?.once?.automations[event];
        if (matchers && matchers.length > 0) consumed.add(componentOnceKey(invocation.key, event));
      }
    },
    hasMatchers: event => configFor(event, 'always') !== undefined || configFor(event, 'once') !== undefined,
  };
}

/**
 * Map one frontmatter hook (the `hooks.md` § *Command hook fields* shape) to the
 * internal automation ACTION shape the runtime executes. The frontmatter format
 * is the Claude/settings nested form — a group `{ matcher, hooks: [ {type,
 * command, timeout, once, …} ] }` — while the runtime's `AutomationsConfig`
 * keys each matcher off an `actions` array (`automations/schemas.ts`), so the
 * per-hook object is remapped here the same way `format-adapters/claude.ts`
 * remaps a plugin's `hooks.json`: `mcp_tool`→`mcp`, `timeout` seconds →
 * `timeoutMs`, and `once`/`if` are dropped from the action itself. `once` was
 * already consumed by the caller to split the tiers.
 *
 * C3.334 — `async` and `asyncRewake` were dropped here too, and that was the
 * defect. They are COMMAND-hook fields (`hooks.md#command-hook-fields`), the
 * frontmatter tier declares hooks *"in the same configuration format as
 * settings-based hooks"* (`hooks.md#hooks-in-skills-and-agents`), and
 * `packages/shared/src/automations/schemas.ts` `HookCommandActionSchema` now
 * declares both — so they travel with the
 * action and `executePluginHookAutomations`, the executor every tier shares,
 * runs the hook in the background exactly as it does for a plugin's. Before
 * this a skill's `async: true` hook BLOCKED its event, which is the one thing
 * the page promises it cannot do.
 */
function frontmatterHookToAction(hook: Record<string, unknown>): Record<string, unknown> {
  const { once: _once, if: _if, hooks: _nested, matcher: _matcher, type, timeout, ...rest } = hook;
  const resolvedType = type === 'mcp_tool' ? 'mcp' : type;
  const timeoutMs = typeof timeout === 'number' && timeout > 0
    ? { timeoutMs: Math.min(Math.round(timeout * 1000), 120_000) }
    : {};
  return {
    ...(typeof resolvedType === 'string' ? { type: resolvedType } : {}),
    ...rest,
    ...timeoutMs,
  };
}

/**
 * Normalize one already-partitioned, `actions`-shaped hook map through the SAME
 * settings-hook validator every other tier uses — no second hook parser. Returns
 * `undefined` when nothing survived validation.
 */
function normalizeComponentHookMap(map: Record<string, unknown[]>, label: string): AutomationsConfig | undefined {
  if (Object.keys(map).length === 0) return undefined;
  const parsed = parseHooksConfigContent(JSON.stringify({ automations: map }), label);
  return Object.keys(parsed.config.automations).length > 0 ? parsed.config : undefined;
}

/**
 * Read a component's frontmatter `hooks` block (`hooks.md` § Hooks in skills and
 * agents) and partition it into the always-on and `once` tiers.
 * `splitMarkdownFrontmatter` keeps the nested mapping OPAQUE on purpose
 * (`format-adapters/shared.ts`: "nested mappings stay opaque"), so the block is
 * re-read here with a real YAML reader — but ONLY the `hooks` key is taken from
 * it; every other frontmatter field still comes from `splitMarkdownFrontmatter`,
 * so the two cannot disagree.
 *
 * Shared by the SKILL parser below and R87b's SUBAGENT parser
 * (`component-hooks.ts`), which is the whole point of it being one function: the
 * frontmatter format is identical for both components (`hooks.md`: "the same
 * configuration format as settings-based hooks"), and the two documented
 * differences are expressed as options rather than as a second parser.
 *
 * - `honourOnce` — `hooks.md`, the `once` field: "Only honored for hooks
 *   declared in skill frontmatter; ignored in settings files and agent
 *   frontmatter." `false` folds every hook into the always tier, so an agent's
 *   `once: true` is read and then ignored exactly as documented.
 * - `renameEvents` — `sub-agents.md`: "When the agent is invoked as a subagent,
 *   `Stop` hooks in frontmatter are automatically converted to `SubagentStop`
 *   events." Applied to the event KEY before normalization, so both spellings
 *   merge into one matcher list and both validate against the same vocabulary.
 *
 * Fails soft, like every other frontmatter reader here: a malformed block yields
 * `undefined` and the component runs without hooks rather than failing to load.
 */
export function partitionFrontmatterHooks(
  content: string,
  options: { honourOnce: boolean; label: string; renameEvents?: Readonly<Record<string, string>> },
): { always?: AutomationsConfig; once?: AutomationsConfig } | undefined {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return undefined;
  let document: unknown;
  try {
    document = loadYaml(lines.slice(1, end).join('\n'));
  } catch {
    return undefined;
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return undefined;
  const hooks = (document as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return undefined;
  const alwaysMap: Record<string, unknown[]> = {};
  const onceMap: Record<string, unknown[]> = {};
  for (const [declaredEvent, groups] of Object.entries(hooks as Record<string, unknown>)) {
    const event = options.renameEvents?.[declaredEvent] ?? declaredEvent;
    const groupList = Array.isArray(groups) ? groups : [groups];
    for (const group of groupList) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
      const groupRecord = group as Record<string, unknown>;
      // Mirror `format-adapters/claude.ts`: an entry with no nested `hooks`
      // array IS the single hook, and a group's `matcher` applies to each of
      // its hooks.
      const hookList = Array.isArray(groupRecord.hooks) ? groupRecord.hooks : [groupRecord];
      const matcher = typeof groupRecord.matcher === 'string' ? groupRecord.matcher : undefined;
      const alwaysActions: unknown[] = [];
      const onceActions: unknown[] = [];
      for (const hook of hookList) {
        if (!hook || typeof hook !== 'object' || Array.isArray(hook)) continue;
        const record = hook as Record<string, unknown>;
        (options.honourOnce && record.once === true ? onceActions : alwaysActions)
          .push(frontmatterHookToAction(record));
      }
      const pushMatcher = (target: Record<string, unknown[]>, actions: unknown[]): void => {
        if (actions.length === 0) return;
        (target[event] ??= []).push({ ...(matcher ? { matcher } : {}), actions });
      };
      pushMatcher(alwaysMap, alwaysActions);
      pushMatcher(onceMap, onceActions);
    }
  }
  const always = normalizeComponentHookMap(alwaysMap, options.label);
  const once = normalizeComponentHookMap(onceMap, options.label);
  if (!always && !once) return undefined;
  return { ...(always ? { always } : {}), ...(once ? { once } : {}) };
}

/**
 * Parse a SKILL's frontmatter `hooks` block: {@link partitionFrontmatterHooks}
 * with `once` honoured (`hooks.md`: "Only honored for hooks declared in skill
 * frontmatter") and no event conversion — a skill's `Stop` stays `Stop`, because
 * the documented `Stop`→`SubagentStop` rule is scoped to subagents.
 */
export function parseSkillFrontmatterHooks(content: string): SkillComponentHooks | undefined {
  const tiers = partitionFrontmatterHooks(content, { honourOnce: true, label: 'skill frontmatter hooks' });
  return tiers ? Object.freeze(tiers) : undefined;
}

/**
 * The restore-path half of {@link parseSkillFrontmatterHooks}: structurally
 * accept a persisted `componentHooks` block WITHOUT re-parsing it, so the stored
 * JSON — which the invocation digest is computed over — round-trips byte for
 * byte. The digest itself is the integrity check; this only rejects a block
 * whose SHAPE could crash the dispatcher.
 */
function staticComponentHooks(value: unknown): SkillComponentHooks | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid skill invocation component hooks');
  }
  const input = value as { always?: unknown; once?: unknown };
  const tier = (config: unknown, field: string): AutomationsConfig | undefined => {
    if (config === undefined) return undefined;
    const automations = config && typeof config === 'object' && !Array.isArray(config)
      ? (config as { automations?: unknown }).automations
      : undefined;
    if (!automations || typeof automations !== 'object' || Array.isArray(automations)) {
      throw new Error(`Invalid skill invocation component hooks ${field}`);
    }
    return config as AutomationsConfig;
  };
  const always = tier(input.always, 'always');
  const once = tier(input.once, 'once');
  if (!always && !once) return undefined;
  return Object.freeze({ ...(always ? { always } : {}), ...(once ? { once } : {}) });
}

function frozenUnsignedRecord(record: UnsignedSkillInvocationRecord): UnsignedSkillInvocationRecord {
  return Object.freeze({
    ...record,
    supportingResources: Object.freeze(record.supportingResources.map(resource => Object.freeze({ ...resource }))),
    restrictions: Object.freeze({
      ...(record.restrictions.tools ? { tools: Object.freeze([...record.restrictions.tools]) } : {}),
      ...(record.restrictions.model ? { model: record.restrictions.model } : {}),
      ...(record.restrictions.agent ? { agent: record.restrictions.agent } : {}),
      // Appended LAST, and only when present: a record with no `effort` keeps
      // exactly the key set — and therefore the digest JSON — it had before this
      // field existed, so every snapshot persisted earlier still restores.
      ...(record.restrictions.effort ? { effort: record.restrictions.effort } : {}),
      // Same rule, one field later: a record with no `disallowed-tools` keeps
      // the key set it had before this field existed.
      ...(record.restrictions.disallowedTools
        ? { disallowedTools: Object.freeze([...record.restrictions.disallowedTools]) }
        : {}),
      // Same rule, one field later: a record with no `context: fork` keeps the
      // key set it had before this field existed.
      ...(record.restrictions.fork ? { fork: frozenSkillForkDispatch(record.restrictions.fork) } : {}),
    }),
    states: Object.freeze({ ...record.states }),
    // Appended LAST, and only when present: a record with no frontmatter hooks
    // keeps exactly the key set — and therefore the digest JSON — it had before
    // this field existed. The reassignment freezes the tier object without
    // moving its position (last), which the `...record` spread already set.
    ...(record.componentHooks ? { componentHooks: Object.freeze({ ...record.componentHooks }) } : {}),
  });
}

export function computeSkillInvocationDigest(record: UnsignedSkillInvocationRecord): string {
  return sha256(JSON.stringify(record));
}

export function assertSkillInvocationBudget(invocations: readonly SkillInvocationRecord[]): void {
  if (Buffer.byteLength(JSON.stringify(invocations), 'utf8') > MAX_SKILL_INVOCATION_BYTES) {
    throw new Error(`Skill invocation snapshot exceeds ${MAX_SKILL_INVOCATION_BYTES} bytes`);
  }
}

export function validateSkillInvocationSnapshot(
  value: unknown,
  expected?: { key: string; sourceDigest: string; generation: string },
): SkillInvocationRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid skill invocation snapshot');
  const input = value as Partial<SkillInvocationRecord>;
  const key = boundedIdentity(input.key, 'key');
  const name = boundedIdentity(input.name, 'name');
  const sourceDigest = typeof input.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(input.sourceDigest)
    ? input.sourceDigest
    : (() => { throw new Error('Invalid skill invocation source digest'); })();
  const generation = boundedIdentity(input.generation, 'generation');
  const invokedAt = input.invokedAt;
  const isLegacySnapshot = invokedAt === undefined;
  if (!isLegacySnapshot && (!Number.isSafeInteger(invokedAt) || invokedAt! < 0)) {
    throw new Error('Invalid skill invocation chronology');
  }
  if (expected && (key !== expected.key || sourceDigest !== expected.sourceDigest || generation !== expected.generation)) {
    throw new Error(`Skill invocation snapshot identity mismatch: ${name}`);
  }
  const body = safeSnapshotText(input.body, 'body', MAX_SKILL_BODY_BYTES);
  if (!Array.isArray(input.supportingResources) || input.supportingResources.length > MAX_SUPPORTING_RESOURCES) {
    throw new Error('Invalid skill invocation supporting resources');
  }
  const supportingResources = input.supportingResources.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid skill supporting resource');
    const resource = value as Partial<SkillSupportingResourceSnapshot>;
    const handle = typeof resource.handle === 'string' && /^skill-resource:[a-f0-9]{64}$/.test(resource.handle)
      ? resource.handle
      : (() => { throw new Error('Invalid skill supporting resource handle'); })();
    const content = safeSnapshotText(resource.content, 'supporting resource', MAX_SUPPORTING_RESOURCE_BYTES);
    const digest = typeof resource.digest === 'string' && /^[a-f0-9]{64}$/.test(resource.digest)
      ? resource.digest
      : (() => { throw new Error('Invalid skill supporting resource digest'); })();
    if (sha256(content) !== digest) throw new Error('Skill supporting resource digest mismatch');
    // A pre-R17 record has no `relativePath`. Its key set — and therefore the
    // JSON the invocation digest is computed over — must stay exactly what it
    // was, or every persisted snapshot fails its own digest check on restore.
    if (resource.relativePath === undefined) return Object.freeze({ handle, digest, content });
    return Object.freeze({
      handle,
      digest,
      relativePath: safeSupportingResourcePath(resource.relativePath),
      content,
    });
  });
  if (new Set(supportingResources.map(resource => resource.handle)).size !== supportingResources.length) {
    throw new Error('Duplicate skill supporting resource handle');
  }
  const rawRestrictions = input.restrictions;
  if (!rawRestrictions || typeof rawRestrictions !== 'object') throw new Error('Invalid skill invocation restrictions');
  const rawTools = rawRestrictions.tools;
  // An EMPTY list is ACCEPTED here, and the two states stay apart: `undefined`
  // is "the author declared no `allowed-tools`", `[]` is "the author declared it
  // and it pre-approves nothing". This mirrored the builder's now-removed empty
  // throw, so once a skill with `allowed-tools: []` became invokable, a
  // `length > 0` guard here would have failed its RESTORE instead — the record
  // keeps the empty array (it is truthy at the spread below, so the key and the
  // digest carry it), and a continuation would have dropped the skill with
  // "could not be restored" while the same skill invoked fine from scratch.
  const tools = rawTools === undefined
    ? undefined
    : Array.isArray(rawTools) && rawTools.length <= 64
      ? rawTools.map(tool => staticRestriction(tool, 'tool')!)
      : (() => { throw new Error('Invalid skill invocation tools restriction'); })();
  const model = staticRestriction(rawRestrictions.model, 'model');
  const agent = staticRestriction(rawRestrictions.agent, 'agent');
  const rawDisallowed = rawRestrictions.disallowedTools;
  const disallowedTools = rawDisallowed === undefined
    ? undefined
    : Array.isArray(rawDisallowed) && rawDisallowed.length > 0 && rawDisallowed.length <= 64
      ? rawDisallowed.map(tool => staticRestriction(tool, 'disallowed tool')!)
      : (() => { throw new Error('Invalid skill invocation disallowedTools restriction'); })();
  const fork = staticForkDispatch(rawRestrictions.fork);
  const restrictions = {
    ...(tools ? { tools: Object.freeze(tools) } : {}),
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(skillEffortLevel(rawRestrictions.effort) ? { effort: skillEffortLevel(rawRestrictions.effort)! } : {}),
    // LAST, matching `frozenUnsignedRecord`: the digest is computed over
    // `JSON.stringify`, so the key ORDER here is part of the snapshot contract.
    ...(disallowedTools ? { disallowedTools: Object.freeze(disallowedTools) } : {}),
    ...(fork ? { fork } : {}),
  };
  const states = input.states;
  if (!states || states.available !== true || states.selected !== true || states.grantApplied !== true || states.resourceLoaded !== (supportingResources.length > 0)) {
    throw new Error('Invalid skill invocation states');
  }
  const componentHooks = staticComponentHooks(input.componentHooks);
  const unsigned = frozenUnsignedRecord({
    key,
    name,
    sourceDigest,
    generation,
    invokedAt: isLegacySnapshot ? 0 : invokedAt!,
    body,
    supportingResources,
    restrictions,
    states: { available: true, selected: true, resourceLoaded: supportingResources.length > 0, grantApplied: true },
    ...(componentHooks ? { componentHooks } : {}),
  });
  const expectedDigest = isLegacySnapshot
    ? sha256(JSON.stringify({
        key,
        name,
        sourceDigest,
        generation,
        body,
        supportingResources,
        restrictions,
        states: unsigned.states,
      }))
    : computeSkillInvocationDigest(unsigned);
  if (typeof input.invocationDigest !== 'string' || expectedDigest !== input.invocationDigest) {
    throw new Error(`Skill invocation digest mismatch: ${name}`);
  }
  const result = Object.freeze({
    ...unsigned,
    invocationDigest: isLegacySnapshot ? computeSkillInvocationDigest(unsigned) : input.invocationDigest,
  });
  assertSkillInvocationBudget([result]);
  return result;
}

/**
 * The malformed-sequence shape, refused rather than tokenized.
 *
 * `allowed-tools: [Read, 1]` is not a list anyone wrote: the frontmatter
 * splitter flattens it to the JSON text `["Read",1]`, and until P2.214 the
 * tokenizer below stripped the brackets and quotes and produced
 * `['Read', '1']` — **a pre-approval for a tool literally named `1`**,
 * measured on this path. Nothing told the author their declaration had not
 * been understood.
 *
 * A YAML flow sequence (`[Read, Grep]`) is NOT this shape: it survives the
 * splitter as a raw scalar with bare words inside, which `JSON.parse` refuses,
 * so it still reaches the tokenizer. Only a sequence that parsed AND carried a
 * non-string item round-trips as valid JSON whose items are not all non-empty
 * strings — exactly the shape with no honest tokenization.
 *
 * This is the ENFORCEMENT half of the refusal the plugin import side already
 * makes (`plugins/format-adapters/shared.ts`'s `isMalformedListValue`, which
 * also raises `plugin.format.skill_grant_list_malformed`). The two are
 * deliberately the same predicate: with only the import side fixed, a malformed
 * list was refused at import and still trusted at invocation, and this file is
 * the copy re-read from disk at invocation time.
 */
function isMalformedToolListText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  return Array.isArray(parsed)
    && !parsed.every(item => typeof item === 'string' && item.trim().length > 0);
}

/**
 * `allowed-tools` / `disallowed-tools`, on every skill path.
 *
 * The tokenizer itself is {@link splitToolGrantList}, shared with the two AGENT
 * tool-list readers — both of which split on a bare comma until P6b, so
 * `Agent(a, b)` in an agent's `tools` was shredded into two names that resolve
 * to nothing while the same text in a skill's `allowed-tools` parsed correctly.
 * One splitter, so the two sides cannot drift apart again; the rules and their
 * doc citations live on it.
 *
 * What stays here is the field's own semantics: `undefined` means the field was
 * absent, while an EMPTY list means it was present and named nothing, which the
 * caller must treat as an empty grant rather than as "unset" — a distinction the
 * enforcement path depends on. A YAML list's entries are taken whole rather than
 * re-tokenized, because the list itself already delimited them.
 */
export function parseSkillToolList(value: unknown): string[] | undefined {
  // A JSON-array-shaped string whose items are not all non-empty strings is the
  // malformed form `flattenFrontmatterValue` emits, not a list the author wrote.
  // Return [] ("declared, pre-approves nothing") rather than tokenizing the JSON.
  if (isMalformedToolListText(value)) return [];
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    : typeof value === 'string'
      ? splitToolGrantList(value)
      : undefined;
  if (!entries) return undefined;
  return Array.from(new Set(entries));
}

/**
 * The `arguments` frontmatter field — "Named positional arguments for `$name`
 * substitution in the skill content. Accepts a space-separated string or a YAML
 * list. Names map to argument positions in order." (`skills.md:256`).
 *
 * SPACE-separated, unlike `paths` (`:267`), which is comma-separated. The
 * frontmatter splitter normalizes a YAML block list to a comma-joined string, so
 * both delimiters have to parse here for a YAML list to survive the trip.
 */
export function skillArgumentNames(value: string | undefined): string[] {
  if (!value) return [];
  // `arguments: [issue, branch]` is the form the docs themselves use (`:297`).
  // The frontmatter splitter keeps a flow sequence as a raw scalar, so the
  // brackets are stripped here rather than left to poison the first and last
  // name — which would silently shift every position after them.
  const trimmed = value.trim();
  const body = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  // Nothing is filtered or de-duplicated here. Order IS the position mapping, so
  // dropping one entry would silently re-point every name after it at the wrong
  // argument. A name that cannot be written as `$name` simply never matches.
  return (body.match(/[^\s,]+/g) ?? []).map(name => name.replace(/^['"]|['"]$/g, ''));
}

/**
 * Split an argument string the way `skills.md:321` describes: "Indexed arguments
 * use shell-style quoting, so wrap multi-word values in quotes to pass them as a
 * single argument."
 *
 * Only the quoting rule is implemented — this is a placeholder expander, not a
 * shell. Nothing here executes, and a lone quote is a literal character rather
 * than an error, so an unbalanced quote cannot make a skill unusable.
 */
function splitSkillArguments(text: string): string[] {
  const values: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) { quote = null; continue; }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) values.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) values.push(current);
  return values;
}

/** What one `$…` placeholder resolved to, and whether it resolved at all. */
type ArgumentPlaceholder =
  /** Expanded to `text`. */
  | { kind: 'value'; length: number; text: string }
  /** `skills.md:323`: an indexed placeholder with no argument "stays in the content unchanged". */
  | { kind: 'literal'; length: number };

/**
 * The documented argument placeholders, matched at ONE position, longest first.
 *
 * Longest-match-at-a-position is the whole ordering policy, and it is not
 * cosmetic: `$ARGUMENTS` is a prefix of `$ARGUMENTS[0]`, and `$1` is a prefix of
 * a declared name such as `1st`. A pass that replaced `$ARGUMENTS` before
 * `$ARGUMENTS[0]` would turn the latter into `<all args>[0]`, and one that
 * replaced `$1` before `$1st` would turn the latter into `<first arg>st`. Both
 * are silent corruption, which is why every form is resolved in a single scan
 * that never re-reads what it just wrote.
 */
function matchArgumentPlaceholder(
  content: string,
  at: number,
  values: readonly string[],
  all: string,
  names: readonly string[],
): (ArgumentPlaceholder & { argumentsToken: boolean }) | null {
  const rest = content.slice(at + 1);

  // 1. `$ARGUMENTS[N]` — `:295`, 0-based index.
  const indexed = /^ARGUMENTS\[(\d+)\]/.exec(rest);
  if (indexed) {
    const length = 1 + indexed[0].length;
    const value = values[Number(indexed[1])];
    return value === undefined
      ? { kind: 'literal', length, argumentsToken: true }
      : { kind: 'value', length, text: value, argumentsToken: true };
  }

  // 2. `$ARGUMENTS` — `:294`/`:321`, "the full argument string as typed".
  if (/^ARGUMENTS(?![A-Za-z0-9_])/.test(rest)) {
    return { kind: 'value', length: 1 + 'ARGUMENTS'.length, text: all, argumentsToken: true };
  }

  // 3. `$name` — `:297`. Checked before the bare `$N` shorthand so a declared
  //    name that starts with a digit wins over its own leading digits. A name
  //    must end on a non-identifier character; `$issues` is a different
  //    identifier from `$issue`, not `$issue` followed by `s`.
  let named: { name: string; index: number } | null = null;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    if (!name || !rest.startsWith(name)) continue;
    if (/[A-Za-z0-9_]/.test(rest.charAt(name.length))) continue;
    if (!named || name.length > named.name.length) named = { name, index };
  }
  if (named) {
    // `:323`: "A named placeholder ... with no matching argument expands to an
    // empty string" — the opposite of the indexed form, deliberately.
    return { kind: 'value', length: 1 + named.name.length, text: values[named.index] ?? '', argumentsToken: false };
  }

  // 4. `$N` — `:296`, shorthand for `$ARGUMENTS[N]`. `argumentsToken` is FALSE:
  //    it decides the `:294` append fallback, which is written against the
  //    `$ARGUMENTS` token specifically, and `$0` is not that token.
  const shorthand = /^\d+/.exec(rest);
  if (shorthand) {
    const length = 1 + shorthand[0].length;
    const value = values[Number(shorthand[0])];
    return value === undefined
      ? { kind: 'literal', length, argumentsToken: false }
      : { kind: 'value', length, text: value, argumentsToken: false };
  }

  return null;
}

/**
 * Expand every documented argument placeholder in one left-to-right pass.
 *
 * Single-pass by design: a substituted value is written to the output and never
 * re-scanned, so an argument that happens to contain `$0` or `${CLAUDE_SKILL_DIR}`
 * is inert text rather than a second round of substitution driven by whoever
 * typed the argument.
 *
 * Returns whether an `$ARGUMENTS`-family placeholder was actually consumed,
 * which is what decides the `:294` append fallback — an ESCAPED `\$ARGUMENTS` is
 * not a placeholder and so does not suppress the append.
 *
 * Exported for the CUSTOM COMMAND path, which `skills.md:16` binds to the same
 * table. Whole line: "**Custom commands have been merged into skills.** A file
 * at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md`
 * both create `/deploy` and work the same way. Your existing `.claude/commands/`
 * files keep working. Skills add optional features: a directory for supporting
 * files, frontmatter to [control whether you or Claude invokes
 * them](#control-who-invokes-a-skill), and the ability for Claude to load them
 * automatically when relevant." — the extras are what a skill adds ON TOP; the
 * substitution table is part of "work the same way".
 *
 * The RPC send handler (`packages/server-core/src/handlers/rpc/sessions.ts`)
 * calls this instead of growing a second matcher; `splitSkillArguments` and
 * `matchArgumentPlaceholder` stay private behind it, and the skills-only
 * `ARGUMENTS: <value>` append keeps reading `sawArgumentsToken` here — the
 * command path ignores that flag.
 */
export function expandSkillArguments(
  content: string,
  argumentsText: string,
  names: readonly string[],
  // The injection guard (`materializeRuntimeSkillInvocation`) expands the body a
  // SECOND time with this set, so it can compare "what the arguments actually
  // substituted" against "what they would substitute if they could not form or
  // break a `` !` `` placeholder". A value cannot open a new placeholder without
  // a backtick, and cannot close/split an author placeholder without a backtick
  // or a newline — so neutralizing exactly those characters in the value makes
  // the arguments inert to placeholder STRUCTURE while leaving author
  // placeholders (`` !`echo $ARGUMENTS` ``) intact. Applied to VALUE text only,
  // never to the author's own body.
  sanitizeValue?: (value: string) => string,
): { text: string; sawArgumentsToken: boolean } {
  const values = splitSkillArguments(argumentsText);
  let out = '';
  let cursor = 0;
  let sawArgumentsToken = false;

  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\\' && content[i + 1] === '$' && content[i - 1] !== '\\') {
      // `:325`: "To include a literal `$` before a digit, `ARGUMENTS`, or a
      // declared argument name ... escape it with a backslash ... A backslash
      // before any other `$` is left unchanged. Only a single backslash directly
      // before the token escapes it. A doubled backslash such as `\\$1` leaves
      // both backslashes in place, and `$1` still expands to the argument value."
      const escaped = matchArgumentPlaceholder(content, i + 1, values, argumentsText, names);
      if (!escaped) continue;
      out += content.slice(cursor, i) + content.slice(i + 1, i + 1 + escaped.length);
      i += escaped.length;
      cursor = i + 1;
      continue;
    }
    if (content[i] !== '$') continue;
    const match = matchArgumentPlaceholder(content, i, values, argumentsText, names);
    if (!match) continue;
    if (match.argumentsToken) sawArgumentsToken = true;
    if (match.kind === 'literal') {
      i += match.length - 1;
      continue;
    }
    out += content.slice(cursor, i) + (sanitizeValue ? sanitizeValue(match.text) : match.text);
    i += match.length - 1;
    cursor = i + 1;
  }

  return { text: out + content.slice(cursor), sawArgumentsToken };
}

/**
 * Neutralize the characters an argument value would need to OPEN a new
 * `` !`…` `` placeholder or to CLOSE/split one the author wrote: a backtick, and
 * a newline (the inline form is `` !`[^`\n]*` ``, so a newline breaks it). Used
 * only to build the comparison body for the injection guard — never to change
 * what the model or the shell actually sees.
 */
export function neutralizeSkillPlaceholderChars(value: string): string {
  return value.replace(/[`\r\n]/g, ' ');
}

/** Arguments following the last matching `[skill:...]` reference, up to the next skill mention. */
export function runtimeSkillArguments(message: string, reference: string): string | undefined {
  const mentions = [...message.matchAll(/\[skill:([^\]\r\n]+)\]/g)];
  let index = -1;
  for (let candidate = 0; candidate < mentions.length; candidate += 1) {
    const match = mentions[candidate]!;
    if (match[1] === reference) index = candidate;
  }
  if (index < 0) return undefined;
  const match = mentions[index]!;
  return message.slice((match.index ?? 0) + match[0].length, mentions[index + 1]?.index).trim();
}

/**
 * Expand presentation-only skill body text. Security frontmatter never enters
 * this path.
 *
 * Host variables run BEFORE arguments, and the order is load-bearing: a host
 * variable's value is a path, a session id or an effort level and can never
 * contain `$ARGUMENTS`, while argument text is whatever a user or the model
 * typed and very much can contain `${CLAUDE_SKILL_DIR}`. Expanding arguments
 * last means their text is never re-scanned by a later pass.
 */
function expandRuntimeSkillBody(
  content: string,
  skill: RuntimeSkillHandle,
  argumentsText?: string,
  skillDirectory?: string,
  options: { argumentNames?: readonly string[]; host?: RuntimeSkillHostContext; sanitizeArgumentValues?: boolean } = {},
): string {
  const runtime = skill.pluginRuntime;
  // Before the plugin-profile pass, because these are defined for every skill
  // origin — the skill directory "regardless of the current working directory",
  // the session/effort variables regardless of whether the skill is native or
  // bundled in a plugin, and the project root "independent of where the skill is
  // installed" (`:307`). The project value resolves to the plugin's own
  // `projectPath` first, so for a `claude-plugin-env-v1` bundle this pass writes
  // exactly what the plugin pass below would have written.
  const projectDirectory = skillProjectDirectory(skill, options.host);
  let expanded = expandSkillVariables(content, {
    skillDirectory,
    ...(options.host?.sessionId ? { sessionId: options.host.sessionId } : {}),
    ...(options.host?.effort ? { effort: options.host.effort } : {}),
    ...(projectDirectory ? { projectDirectory } : {}),
  });

  if (runtime) {
    const environment = pluginRuntimeEnvForProfile(runtime.profile, {
      bundleRoot: runtime.rootPath,
      dataPath: runtime.dataPath,
      ...(runtime.projectPath ? { projectPath: runtime.projectPath } : {}),
    });

    for (const [name, value] of Object.entries(environment)) {
      expanded = expanded.split(`\${${name}}`).join(value);
      expanded = expanded.replace(new RegExp(`\\$${name}(?![A-Za-z0-9_])`, 'g'), () => value);
    }
  }

  // `plugins/manifest-reference.md#environment-variables` — "Non-sensitive values can also be substituted
  // in skill and agent content." Only the `${user_config.KEY}` spelling: there
  // is no bare-`$` form for this family, unlike the environment names above.
  //
  // The map the resolver builds carries non-sensitive values ONLY, so a
  // sensitive option referenced here stays a literal placeholder — which is the
  // containment, not an oversight. A skill body reaches the model, the
  // persisted invocation record and the transcript, and a secret substituted in
  // has no boundary left to be redacted at.
  //
  // An unset key also stays literal, matching the rule this file already states
  // for every other variable: "a variable the host cannot supply leaves its
  // variable literal rather than expanding to something wrong". A skill body is
  // instruction prose, so a surviving placeholder degrades to a sentence the
  // model can read; the MCP and LSP sites, where the same placeholder would
  // become a credential, refuse to start instead.
  //
  // Before argument expansion, like every other pass here: argument text is
  // whatever a user or the model typed, and a `${user_config.TOKEN}` inside it
  // must never be re-scanned into a value.
  for (const [key, value] of Object.entries(skill.pluginUserConfig ?? {})) {
    expanded = expanded.split(`\${user_config.${key}}`).join(value);
  }

  if (argumentsText === undefined) return expanded;
  const substituted = expandSkillArguments(
    expanded,
    argumentsText,
    options.argumentNames ?? [],
    options.sanitizeArgumentValues ? neutralizeSkillPlaceholderChars : undefined,
  );
  // `:294`/`:454`: "If you invoke a skill with arguments but the skill doesn't
  // include `$ARGUMENTS`, Claude Code appends `ARGUMENTS: <your input>` to the
  // end of the skill content so Claude still sees what you typed." Read on the
  // `$ARGUMENTS` FAMILY (`$ARGUMENTS` and `$ARGUMENTS[N]`, the two forms whose
  // text is literally `$ARGUMENTS`): a body that only uses `$0` or `$name` still
  // gets the append, because the docs name that token and not "any placeholder".
  if (substituted.sawArgumentsToken || !argumentsText.trim()) return substituted.text;
  return `${substituted.text}\n\nARGUMENTS: ${argumentsText}`;
}

interface SupportingReference {
  raw: string;
  relativePath: string;
}

function supportingReferences(body: string): SupportingReference[] {
  const rawReferences = [
    ...[...body.matchAll(/\]\(\s*<?([^\s)>]+)>?(?:\s+['"][^'"]*['"])?\s*\)/g)].map(match => match[1]!),
    ...[...body.matchAll(/`((?:\.\/)?(?:references|scripts|assets|examples)\/[A-Za-z0-9._/-]+)`/g)].map(match => match[1]!),
  ];
  const byPath = new Map<string, SupportingReference>();
  for (const raw of rawReferences) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#') || raw.startsWith('/')) continue;
    if (raw.includes('\\') || raw.includes('\0')) throw new Error('Invalid skill supporting resource path');
    const withoutSuffix = raw.split(/[?#]/, 1)[0]!.replace(/^\.\//, '');
    const relativePath = posix.normalize(withoutSuffix);
    if (!relativePath || relativePath === '.' || relativePath === 'SKILL.md' || relativePath.startsWith('../') || relativePath.includes('/../')) {
      if (relativePath !== 'SKILL.md') throw new Error('Invalid skill supporting resource path');
      continue;
    }
    byPath.set(relativePath, { raw, relativePath });
  }
  if (byPath.size > MAX_SUPPORTING_RESOURCES) {
    throw new Error(`Skill supporting resources exceed ${MAX_SUPPORTING_RESOURCES} entries`);
  }
  return [...byPath.values()];
}

async function materializeSupportingResources(input: {
  materializer: CapabilitySnapshotMaterializer;
  skill: RuntimeSkillHandle;
  body: string;
}): Promise<{ body: string; resources: readonly SkillSupportingResourceSnapshot[] }> {
  const references = supportingReferences(input.body);
  if (references.length === 0) return { body: input.body, resources: Object.freeze([]) };
  if (!input.materializer.readRelativeText) {
    throw new Error(`Skill supporting resources unavailable: ${input.skill.logicalName}`);
  }
  let body = input.body;
  const resources: SkillSupportingResourceSnapshot[] = [];
  for (const reference of references) {
    const loaded = await input.materializer.readRelativeText(input.skill.resource, reference.relativePath);
    const content = safeSnapshotText(loaded.content, 'supporting resource', MAX_SUPPORTING_RESOURCE_BYTES);
    const digest = sha256(content);
    if (loaded.contentHash !== digest) throw new Error(`Skill supporting resource changed: ${input.skill.logicalName}`);
    const handle = `skill-resource:${sha256(`${input.skill.key}\0${input.skill.resource.contentHash}\0${reference.relativePath}\0${digest}`)}`;
    resources.push(Object.freeze({
      handle,
      digest,
      relativePath: safeSupportingResourcePath(reference.relativePath),
      content,
    }));
    body = body.split(reference.raw).join(handle);
  }
  return { body, resources: Object.freeze(resources) };
}

/**
 * The host-derived value of `${NESSY_SKILL_DIR}` / `${CLAUDE_SKILL_DIR}`, or
 * `undefined` when the materializer cannot supply one — in which case the
 * variable stays literal, exactly as an unknown variable does, rather than
 * expanding to something wrong.
 */
async function resolveSkillDirectory(
  materializer: CapabilitySnapshotMaterializer,
  skill: RuntimeSkillHandle,
): Promise<string | undefined> {
  if (!materializer.resolveSkillDirectory) return undefined;
  return materializer.resolveSkillDirectory(skill.resource);
}

/**
 * Materialize one pinned skill instruction body and expand only invocation
 * arguments, the host variables, and the compatibility variables declared by its
 * normalized plugin runtime profile. Security frontmatter is deliberately
 * excluded. Host process.env is never consulted, and unknown variables remain
 * literal.
 */
export async function materializeRuntimeSkillContent(
  materializer: CapabilitySnapshotMaterializer,
  skill: RuntimeSkillHandle,
  argumentsText?: string,
  host?: RuntimeSkillHostContext,
): Promise<string> {
  const content = await materializer.readText(skill.resource);
  const { body, frontmatter } = splitMarkdownFrontmatter(content);
  return expandRuntimeSkillBody(
    body,
    skill,
    argumentsText,
    await resolveSkillDirectory(materializer, skill),
    { argumentNames: skillArgumentNames(frontmatter.arguments), ...(host ? { host } : {}) },
  );
}

/**
 * Expand a security restriction's TWO documented variables, and degrade the rest.
 *
 * `skills.md:309` names the pair — `${CLAUDE_SKILL_DIR}` and
 * `${CLAUDE_PROJECT_DIR}` — substituted in "the skill's markdown content, and
 * Bash rules in the `allowed-tools` frontmatter", paired with the same string in
 * the body "so the script runs without prompting" (`:321`). Both values are
 * HOST-derived (`materializer.resolveSkillDirectory`, the session's project
 * root), never author- or model-supplied, so expanding them cannot widen a rule
 * beyond what the host itself chose.
 *
 * Everything else stays LITERAL. This used to throw, which made a
 * documented-valid `allowed-tools: Bash(${CLAUDE_PROJECT_DIR}/…)` abort the whole
 * invocation — an outcome `:323` explicitly rules out: an unsubstituted variable
 * means "the rule stays a literal `${CLAUDE_SKILL_DIR}` string and never matches,
 * so the command still prompts for permission". A literal is the SAFE degrade in
 * both directions: in `allowed-tools` it is a grant nothing matches, and in
 * `disallowed-tools` the tool name in front of the parenthesis still removes the
 * tool. Argument text is still never substituted here, which is the invariant
 * that actually matters — a model-supplied `$ARGUMENTS` cannot become a grant.
 *
 * `${CLAUDE_PLUGIN_ROOT}` is deliberately NOT expanded here: `plugins-reference.md`
 * § Environment variables scopes plugin placeholders to "Skill and agent content"
 * — the body — and `skills.md:309` names only the two above for the frontmatter
 * site. A plugin skill grants its own bundled script through `${CLAUDE_SKILL_DIR}`,
 * which `:306` defines as "the skill's subdirectory within the plugin".
 */
function resolveRestriction(
  value: string | undefined,
  variables: SkillRestrictionVariables,
): string | undefined {
  if (value === undefined) return undefined;
  return expandRestrictionVariables(value, variables);
}

export async function materializeRuntimeSkillInvocation(input: {
  materializer: CapabilitySnapshotMaterializer;
  skill: RuntimeSkillHandle;
  generation: string;
  invokedAt?: number;
  argumentsText?: string;
  host?: RuntimeSkillHostContext;
}): Promise<SkillInvocationRecord> {
  const content = await input.materializer.readText(input.skill.resource);
  const { body: rawBody, frontmatter } = splitMarkdownFrontmatter(content);
  // Resolved ONCE and threaded into both documented substitution sites, so the
  // body's command and the `allowed-tools` rule cannot disagree about where the
  // skill lives — or about where the project is — which is the only reason the
  // pair runs without a prompt.
  const skillDirectory = await resolveSkillDirectory(input.materializer, input.skill);
  const restrictionVariables: SkillRestrictionVariables = {
    ...(skillDirectory ? { skillDirectory } : {}),
    ...(skillProjectDirectory(input.skill, input.host) ? { projectDirectory: skillProjectDirectory(input.skill, input.host)! } : {}),
  };
  const effort = skillEffortLevel(frontmatter.effort);
  // `:299` calls `${CLAUDE_EFFORT}` "the current effort level ... Use this to
  // adapt skill instructions to the active effort setting", and `:262` says the
  // skill's own `effort` "Overrides the session effort level" while it is
  // active. A body that branches on the variable must therefore read the level
  // it will actually run under, not the one it just overrode.
  const host = effort ? { ...input.host, effort } : input.host;
  const expandedBody = expandRuntimeSkillBody(rawBody, input.skill, input.argumentsText, skillDirectory, {
    argumentNames: skillArgumentNames(frontmatter.arguments),
    ...(host ? { host } : {}),
  });
  const supporting = await materializeSupportingResources({
    materializer: input.materializer,
    skill: input.skill,
    body: expandedBody,
  });
  const body = supporting.body;
  if (!body.trim()) throw new Error(`Skill unavailable: ${input.skill.logicalName}`);
  // `skills.md` — "Substitution runs once over the original file." Ours runs on
  // the record body, which is the original file AFTER `$ARGUMENTS` and variable
  // expansion, so a user-supplied argument carrying `` !`…` `` would otherwise
  // become an executable placeholder the skill's author never wrote.
  //
  // A COUNT comparison is not enough: an argument can DESTROY one author
  // placeholder (a stray backtick/newline breaks the inline form) and CREATE one
  // of its own in the same substitution, leaving the count unchanged. So compare
  // the placeholder SET against a body expanded with the argument values
  // neutralized (`sanitizeArgumentValues`) — where the arguments cannot form or
  // break a placeholder. Every author placeholder, including `` !`echo
  // $ARGUMENTS` ``, survives that neutralization unchanged; only an
  // argument-injected one differs. Any placeholder present in the real body but
  // not in the neutralized one is therefore author-unwritten, and the turn fails
  // instead of running it.
  const safeExpandedBody = expandRuntimeSkillBody(rawBody, input.skill, input.argumentsText, skillDirectory, {
    argumentNames: skillArgumentNames(frontmatter.arguments),
    ...(host ? { host } : {}),
    sanitizeArgumentValues: true,
  });
  const authorized = new Set(parseRuntimeSkillContextCommands(safeExpandedBody).map(command => command.command));
  const injected = parseRuntimeSkillContextCommands(expandedBody)
    .find(command => !authorized.has(command.command));
  if (injected) {
    throw new Error(`runtime-skill-context-command-injected: ${input.skill.logicalName}`);
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_SKILL_BODY_BYTES) throw new Error(`Skill body exceeds ${MAX_SKILL_BODY_BYTES} bytes: ${input.skill.logicalName}`);
  const toolsValue = resolveRestriction(frontmatter.tools ?? frontmatter['allowed-tools'], restrictionVariables);
  const model = resolveRestriction(frontmatter.model, restrictionVariables);
  const agent = resolveRestriction(frontmatter.agent, restrictionVariables);
  // An EMPTY `allowed-tools` is a legal declaration and pre-approves nothing.
  // This threw until 2026-08-13 — "a grant that names nothing grants nothing and
  // must fail loudly" — which was sound under the CEILING model it was written
  // for: an empty ceiling meant no tool was permitted, so the turn could do
  // nothing and failing said so. Q9 replaced that model, and under the
  // pre-approval one the same list means only that no tool skips its prompt,
  // while "every tool remains callable, and your permission settings still
  // govern tools that are not listed". The throw therefore stopped guarding
  // anything and made a documented-legal skill impossible to invoke at all.
  //
  // `[]` is kept DISTINCT from `undefined` the whole way down — the record
  // carries the author's declaration, and {@link collectSkillToolGrants} already
  // contracts for both values ("an empty array means one declared it and it
  // pre-approves nothing"). Nothing downstream treats them differently:
  // `setSkillInvocationToolGrants([])` installs an empty grant map, and
  // `skillGrantAllows` reads it exactly as it reads the absent one.
  const tools = parseSkillToolList(toolsValue);
  // `disallowed-tools` (`skills.md:262`), on the same footing since the above:
  // a grant that names nothing pre-approves nothing and a subtraction that names
  // nothing removes nothing. Neither is an authoring error.
  const disallowedValue = resolveRestriction(
    frontmatter['disallowed-tools'] ?? frontmatter.disallowedTools,
    restrictionVariables,
  );
  const disallowedTools = parseSkillToolList(disallowedValue);
  // `skills.md:268` — `agent` is "Which subagent type to use when `context: fork`
  // is set". Under `context: fork` it is therefore the fork TARGET and not the
  // invoking turn's subagent ceiling: the skill's content never enters that turn,
  // so narrowing it would restrict the parent on behalf of text it cannot see.
  // Without the branch the two meanings would collide in one field, and the
  // non-forked ceiling is the one that already has consumers.
  const fork = isSkillForkContext(frontmatter.context)
    ? frozenSkillForkDispatch({
      ...(agent && agent !== 'inherit' ? { agent } : {}),
      // `:265` — under `context: fork` the value is the CHILD's model. `inherit`
      // is the documented "keep the active model" keyword, which for a child is
      // the absence of an override.
      ...(model && model !== 'inherit' ? { model } : {}),
      background: skillFrontmatterBoolean(frontmatter.background) ?? true,
    })
    : undefined;
  const ceilingAgent = fork ? undefined : agent;
  const ceilingModel = fork ? undefined : model;
  // R87 — the frontmatter `hooks` block, read from the RAW file content (its
  // nested mapping is opaque to `splitMarkdownFrontmatter`). No security
  // variable is expanded into a hook body here: hook commands run through the
  // host's injected command runner under the same permission/isolation path as
  // plugin hooks, and `skills.md:309` names only `allowed-tools` rules and the
  // body as substitution sites.
  const componentHooks = parseSkillFrontmatterHooks(content);
  const record = frozenUnsignedRecord({
    key: input.skill.key,
    name: input.skill.logicalName,
    sourceDigest: input.skill.resource.contentHash,
    generation: input.generation,
    invokedAt: input.invokedAt ?? 0,
    body,
    supportingResources: supporting.resources,
    restrictions: {
      ...(tools ? { tools: Object.freeze(tools) } : {}),
      ...(ceilingModel ? { model: ceilingModel } : {}),
      ...(ceilingAgent ? { agent: ceilingAgent } : {}),
      ...(effort ? { effort } : {}),
      ...(disallowedTools?.length ? { disallowedTools: Object.freeze(disallowedTools) } : {}),
      ...(fork ? { fork } : {}),
    },
    states: { available: true, selected: true, resourceLoaded: supporting.resources.length > 0, grantApplied: true },
    ...(componentHooks ? { componentHooks } : {}),
  });
  const invocation = Object.freeze({ ...record, invocationDigest: computeSkillInvocationDigest(record) });
  assertSkillInvocationBudget([invocation]);
  return invocation;
}

const TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  glob: 'find',
  shell: 'bash',
  task: 'subagent',
  webfetch: 'web_fetch',
  websearch: 'web_search',
});

function canonicalTool(tool: string): string {
  const normalized = tool.trim().toLowerCase();
  return TOOL_ALIASES[normalized] ?? normalized;
}

/**
 * One parsed `allowed-tools` entry.
 *
 * `skills.md:303` names Bash rules in `allowed-tools` as one of the two
 * documented substitution sites, and `:315` gives the canonical pair — a rule
 * that "matches the exact command the skill body tells Claude to run, so the
 * script runs without prompting". So an entry is not just a tool name: it is a
 * name plus, optionally, what the tool is allowed to be called WITH.
 */
export interface SkillToolGrant {
  /** Canonical tool name — through `canonicalTool`, so aliases and case are unchanged. */
  readonly name: string;
  /**
   * Argument patterns from the parameterized `Name(pattern)` form, VERBATIM: a
   * pattern holds a real filesystem path (the skill-directory variable is
   * already expanded by the time an entry gets here), so it must never be
   * lowercased the way the name is.
   *
   * `undefined` is the BARE form, and it is the WIDER grant — the tool is
   * allowed with any argument, byte-identical to what an entry meant before
   * patterns existed.
   */
  readonly patterns?: readonly string[];
}

/**
 * `Name` or `Name(pattern)`. The name may not contain a parenthesis; the
 * pattern may — `.*` is greedy and the anchor takes the LAST `)`, so
 * `Bash(echo (hi))` keeps `echo (hi)` verbatim. Anything that does not close
 * (`Bash(`) simply is not the parameterized form and falls through to the bare
 * branch, where it becomes a tool name no call can ever equal.
 */
const SKILL_TOOL_ENTRY = /^([^()]+)\((.*)\)$/s;

/**
 * Parse one `allowed-tools` entry into a grant.
 *
 * The single place an entry is split, so the ceiling and the enforcement point
 * cannot disagree about what the author wrote — which is exactly how the
 * parameterized form came to be DENIED: it was parsed as one opaque lowercased
 * string that no tool name could ever match.
 */
export function parseSkillToolEntry(entry: string): SkillToolGrant {
  const match = SKILL_TOOL_ENTRY.exec(entry.trim());
  if (!match) return { name: canonicalTool(entry) };
  return { name: canonicalTool(match[1]!), patterns: Object.freeze([match[2]!]) };
}

/**
 * Merge two grants for the SAME tool.
 *
 * A bare entry wins: it is the wider grant, and a merge must never NARROW a
 * tool that one skill pre-approved unconditionally. Two parameterized entries
 * union their patterns — each is a separate thing the author said the tool may
 * be called with.
 */
function mergeSkillToolGrants(left: SkillToolGrant, right: SkillToolGrant): SkillToolGrant {
  if (!left.patterns || !right.patterns) return { name: left.name };
  return { name: left.name, patterns: Object.freeze([...new Set([...left.patterns, ...right.patterns])]) };
}

/** Collapse repeated names within one entry list, first-seen order preserved. */
function collapseSkillToolGrants(grants: readonly SkillToolGrant[]): SkillToolGrant[] {
  const byName = new Map<string, SkillToolGrant>();
  for (const grant of grants) {
    const existing = byName.get(grant.name);
    byName.set(grant.name, existing ? mergeSkillToolGrants(existing, grant) : grant);
  }
  return [...byName.values()];
}

/**
 * Every invoked skill's `allowed-tools`, as ONE pre-approval list.
 *
 * `skills.md` frontmatter table, quoted from the raw page
 * (`curl -sL https://code.claude.com/docs/en/skills.md`, fetched 2026-08-13):
 * "Tools Claude can use **without asking permission** during the turn that
 * invokes this skill. The grant clears when you send your next message." And
 * § *Pre-approve tools for a skill*, the sentence that fixes the field's SHAPE:
 * "It does not restrict which tools are available: every tool remains callable,
 * and your permission settings still govern tools that are not listed."
 *
 * So this UNIONS where the ceiling it replaced intersected. Two active skills
 * each pre-approve their own list; a grant only one of them names must survive,
 * because a grant cannot take a tool away — only `disallowed-tools` removes
 * (see {@link collectSkillDisallowedTools}, which unions for the mirror-image
 * reason). Names are merged by {@link mergeSkillToolGrants}, so a bare entry
 * still wins over a parameterized one as the wider grant.
 *
 * `undefined` means no invoked skill declared the field at all; an empty array
 * means one declared it and it pre-approves nothing. Neither is an error — an
 * empty grant is a no-op, not an empty ceiling.
 */
export function collectSkillToolGrants(
  invocations: readonly SkillInvocationRecord[],
): SkillToolGrant[] | undefined {
  let granted: SkillToolGrant[] | undefined;
  for (const invocation of invocations) {
    if (!invocation.restrictions.tools) continue;
    granted = [...(granted ?? []), ...invocation.restrictions.tools.map(parseSkillToolEntry)];
  }
  return granted ? collapseSkillToolGrants(granted) : undefined;
}

/**
 * Canonicalize the runtime's own pinned tool list — a child session's
 * `piAllowedTools`/agent `tools` ceiling, which DOES restrict which tools exist.
 *
 * A skill's `allowed-tools` no longer narrows it: per the sentence quoted on
 * {@link collectSkillToolGrants}, the field "does not restrict which tools are
 * available". So this function stopped narrowing and started canonicalising, and
 * for two passes it kept a name and a parameter from the ceiling era because the
 * rename needed a call site in `SessionManager.ts` that the lane holding this
 * file was zoned out of.
 *
 * P2.338, 2026-09-04: DONE. `narrowRuntimeSkillTools` -> this name, and the
 * `invocations` parameter — which the body discarded with `void invocations;` —
 * is gone with it. Both halves in one commit, because a definition and its only
 * product call site cannot be split by a pathspec commit.
 *
 * AN EMPTY POOL IS ADMITTED, NOT REFUSED — P2.202, and this function used to be
 * the one place in the codebase that disagreed.
 *
 * It threw `Child session agent tool ceilings have an empty intersection`,
 * spawn-fatally, on a pool that arrived empty. `errors.md`
 * § *Agent would be spawned with zero tools*, re-fetched 2026-08-27: "Omitting
 * the `tools` field never triggers this refusal. If you leave the `tools` list
 * empty, or `disallowedTools` removes every entry in it, Claude Code also skips
 * the refusal and launches the subagent without tools." Both named causes reach
 * exactly this line — `current` is the agent's `restrictions.tools` intersected
 * with the parent's (`SessionManager`'s child-session admission), and the
 * spawner's own `allowedTools` has already applied `disallowedTools` to it — so
 * the divergence was live on the sentence's own second clause, not on a
 * hypothesis about the first.
 *
 * The page's refusal is for entries that FAIL TO RESOLVE — a typo, a tool
 * subagents cannot use — which is a different cause with the same end state, and
 * it costs one launch rather than the conversation. We do not implement that
 * refusal at all; `buildPiRuntimeAgentDefinitions` drops unresolvable entries
 * and names them in the debug log instead.
 *
 * Two neighbours already read the sentence this way and said so in their own
 * comments, which is what settled it: `claude-runtime-agents.ts` ("AN EMPTIED
 * GRANT IS NOT A REFUSAL") and `agents/definitions.ts`' `tools` call site. With
 * this line gone the four sites that answer "what is an empty tool pool" agree.
 *
 * NO KNOWN GAPS REMAIN. Both were owned by `SessionManager.ts`, which the P2.202
 * lane was zoned out of; both are closed. Their paragraphs are kept below as
 * closed notes rather than deleted, because a `KNOWN GAP` heading is read as a
 * live warning and a deleted one invites the next reader to rediscover — and
 * re-fix — a defect that is already gone. This is still the function a reader
 * reaches when they ask why a child could call nothing, so this is where the
 * answer belongs.
 *
 * 1. CLOSED by P2.272 + P2.302. DO NOT RE-FIX, and in particular do not "fix" it
 *    by restoring a refusal. It read "NO SURFACE … nothing tells the user why
 *    the child was useless", and asked for exactly what landed: a diagnostic
 *    beside `runtime-agent-tool-unavailable` in the child-admission block, a
 *    NOTICE and not a refusal. `SessionManager.appendEmptyChildToolPoolNotice`
 *    is it — a transcript row plus a live `info` event — paired with an
 *    `agent_admitted_without_tools` code on the admission receipt, which is the
 *    machine-readable half. It is derived at the single seam where the child's
 *    final pool is known, so it fires on every route that can empty one and
 *    names which route did: the caller's own empty list (the spawner's
 *    `disallowedTools` filter, or an authored `tools: []`), an empty parent
 *    ceiling, a disjoint intersection with it, or the skill `disallowed-tools`
 *    chokepoint. Still rare for a runtime agent, for the reason this paragraph
 *    always gave: `buildPiRuntimeAgentDefinitions` unions the five
 *    always-available task tools into every child's pool, so reaching zero takes
 *    a session whose manifest carries none of them, or a `disallowedTools` that
 *    covers them too.
 *
 * 2. CLOSED by `e5c85f138` (P2.273 + P2.301). DO NOT RE-FIX. This paragraph
 *    used to read "A PRODUCER THAT COLLAPSES ABSENT ONTO EMPTY … NOT fixed by
 *    this row", and it made three claims that were each true when written and
 *    are each false now:
 *    - that the plugin-hook producer builds its child's ceiling as
 *      `definition.tools ? [...definition.tools] : []`, collapsing "inherit the
 *      parent's pool" onto the empty SET. It now writes `: undefined` and
 *      spreads the key conditionally — `...(declaredTools ? { tools:
 *      declaredTools } : {})` — the idiom `skillKeys`/`mcpServerKeys`/`memory`
 *      already used beside it;
 *    - that `PiChildRestrictionsV1.tools` is required, so the route cannot
 *      express "inherit" by omission. It is `tools?: string[]`, absence means
 *      "no ceiling", and both layers under the transport already read it that
 *      way (`piAllowedTools`, `resolvePiAllowedBindingNames`);
 *    - that the route is UNTESTED for that shape, every fixture in
 *      `SessionManager.plugin-hook-runners.test.ts` declaring `tools`. Two
 *      fixtures now pin the two shapes APART — "an omitted `tools:` reaches the
 *      child as an omitted ceiling, not the empty set" (`tools` absent, and
 *      absent by omission) and "keeps an authored-empty `tools: []` as the
 *      empty pool it declared" (`'tools' in restrictions === true`) — plus one
 *      in `SessionManager.orchestration.test.ts` driving the real port.
 *    What survives from it is the conclusion, which is still binding: the fix
 *    belonged at that producer, not here, and keeping a refusal at admission to
 *    paper over an empty pool would re-break the contract the paragraph above
 *    exists to honour.
 */
export function canonicalizeRuntimeSkillToolGrants(
  current: readonly string[] | undefined,
): SkillToolGrant[] | undefined {
  if (!current) return undefined;
  const available = new Set(current.map(entry => parseSkillToolEntry(entry).name));
  return [...available].map(name => ({ name }));
}

/**
 * The union of every invoked skill's `disallowed-tools`.
 *
 * UNION, and the design contrast that word is drawing: a grant that only one
 * skill names must not survive the other, so grants would intersect; a removal
 * that only one skill names must still take effect, so removals accumulate — and
 * removals are what this function does. `skills.md:430` frames the field as
 * removal from the pool "while a skill is active", and two active skills each
 * remove their own.
 *
 * This sentence used to make that contrast by naming the neighbour as the thing
 * that "intersects", and the neighbour stopped intersecting when `allowed-tools`
 * stopped being a ceiling — so the sentence was false at HEAD for two passes and
 * the name it leaned on was false with it. Both are fixed together (P2.338,
 * 2026-09-04): the neighbour is {@link canonicalizeRuntimeSkillToolGrants} and
 * the contrast no longer depends on what it is called.
 *
 * Matched on the tool NAME, the same granularity `disallowedTools` already has
 * for subagents (`spawner.ts:201`), because the documented effect is pool
 * removal rather than an argument constraint. A parameterized entry is kept
 * verbatim so a future argument-level reader sees what the author wrote; the
 * matcher reads the name in front of the parenthesis.
 */
export function collectSkillDisallowedTools(
  invocations: readonly SkillInvocationRecord[],
): string[] | undefined {
  const denied: string[] = [];
  for (const invocation of invocations) {
    for (const entry of invocation.restrictions.disallowedTools ?? []) {
      const name = parseSkillToolEntry(entry).name;
      if (name && !denied.includes(name)) denied.push(name);
    }
  }
  return denied.length > 0 ? denied : undefined;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Advertise one supporting resource WITHOUT its bytes.
 *
 * `skills.md` ("Add supporting files"): reference material should load "only
 * when needed", and SKILL.md should point at each file "so Claude knows what
 * each file contains and when to load it". So the tag carries what a decision
 * needs — the relative path, the size, and the handle to fetch with — and the
 * body goes through `read_skill_resource`. A pre-R17 record has no
 * `relativePath`; it still renders, just without the `path` hint.
 */
function formatSupportingResource(resource: SkillSupportingResourceSnapshot): string {
  const path = resource.relativePath ? ` path="${escapeAttribute(resource.relativePath)}"` : '';
  return `<skill-resource handle="${resource.handle}" digest="${resource.digest}"${path}`
    + ` bytes="${Buffer.byteLength(resource.content, 'utf8')}"/>`;
}

/**
 * Render one pinned skill for a model.
 *
 * `renderedBody` is the body with its `` !`<command>` `` placeholders already
 * replaced (`renderRuntimeSkillContextBodies`); it defaults to the record's own
 * body, which is what a route with nothing to execute passes. THE record itself
 * never changes: `invocationDigest`, `assertSkillInvocationBudget` and the
 * persisted continuation snapshot keep describing the source file, so volatile
 * command output stays out of session state and out of every digest.
 *
 * The parameter exists because the substitution must sit BELOW the branch
 * between an inline skill and one whose body drives a child session — putting it
 * inside `formatPinnedSkillInstructions` would have left the child route (and
 * the page's own `pr-summary`, which is both forked and placeholder-bearing)
 * shipping literal `` !`gh pr diff` `` text.
 */
export function formatRuntimeSkillInvocation(
  invocation: SkillInvocationRecord,
  renderedBody: string = invocation.body,
): string {
  const resources = invocation.supportingResources.map(formatSupportingResource).join('\n');
  return `<invoked-skill key="${escapeAttribute(invocation.key)}" name="${escapeAttribute(invocation.name)}" source-digest="${invocation.sourceDigest}" generation="${escapeAttribute(invocation.generation)}" invocation-digest="${invocation.invocationDigest}" available="true" selected="true" resource-loaded="${invocation.states.resourceLoaded}" grant-applied="true">\n${renderedBody}${resources ? `\n${resources}` : ''}\n</invoked-skill>`;
}

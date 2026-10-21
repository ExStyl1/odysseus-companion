/**
 * `skillOverrides` — per-skill visibility from settings instead of frontmatter
 * (R61 · f060 f171).
 *
 * `skills.md:663`, quoted whole:
 *
 * > The `skillOverrides` setting controls skill visibility from your
 * > [settings](/docs/en/settings) instead of the skill's own frontmatter. Use it
 * > for skills whose SKILL.md you don't want to edit, such as ones checked into
 * > a shared project repo. The `/skills` menu writes it for you: highlight a
 * > skill and press `Space` to cycle states, then `Enter` to save to
 * > `.claude/settings.local.json`.
 *
 * `skills.md:667`-`:672`, the state table verbatim:
 *
 * > | Value                   | Listed to Claude     | In `/` menu |
 * > | :---------------------- | :------------------- | :---------- |
 * > | `"on"`                  | Name and description | Yes         |
 * > | `"name-only"`           | Name only            | Yes         |
 * > | `"user-invocable-only"` | Hidden               | Yes         |
 * > | `"off"`                 | Hidden               | Hidden      |
 *
 * `skills.md:676`, quoted whole:
 *
 * > As of v2.1.199, `"off"` also hides the skill from the command lists
 * > advertised to [Remote Control](/docs/en/remote-control) clients and to
 * > [Agent SDK](/docs/en/agent-sdk/slash-commands) callers, not only the
 * > terminal `/` menu. Invoking a hidden skill by its full name still returns
 * > the `skillOverrides` error instead of running it.
 *
 * `skills.md:678` — "A skill that is absent from `skillOverrides` is treated as
 * `"on"`." `skills.md:689` — "Plugin skills are not affected by
 * `skillOverrides`. Manage those through `/plugin` instead."
 *
 * ## The value vocabulary is not invented here
 *
 * The four states and their meanings are declared normatively in the vendored Pi
 * bundle (`packages/pi-agent-server/dist/index.js`) as
 * `z.record(z.string(), z.enum(["on", "name-only", "user-invocable-only",
 * "off"])).optional()`, described there as: "Per-skill listing overrides keyed
 * by skill name. `name-only` lists the skill without its description;
 * `user-invocable-only` hides it from the model but keeps `/name`; `off` hides
 * it from both. Absent = on." {@link SKILL_OVERRIDE_STATES} mirrors that enum
 * rather than re-deriving it from prose.
 *
 * ## Not built here, deliberately
 *
 * The `/skills` menu that WRITES the key (`:663`) has no analogue in this fork,
 * and `:674`'s label for the middle state — "The `/skills` menu labels the
 * `"user-invocable-only"` state `user-only`" — belongs to that writer. Shipping
 * the label alone would be an unused identifier; it is recorded here so the
 * writer half does not have to re-derive it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePermissionJsonc } from '../agent/pi-harness/permission-dsl.ts';

/** The settings-file key, spelled exactly as `skills.md:663` names it. */
export const SKILL_OVERRIDES_SETTING_KEY = 'skillOverrides';

/**
 * The four states, in the order the Pi bundle's `z.enum` declares them (which is
 * also `skills.md:667`-`:672`'s table order, most visible to least).
 */
export const SKILL_OVERRIDE_STATES = ['on', 'name-only', 'user-invocable-only', 'off'] as const;

export type SkillOverrideState = (typeof SKILL_OVERRIDE_STATES)[number];

/** Where a `.claude` settings file lives, relative to the project directory. */
const CLAUDE_SETTINGS_FILES = {
  project: join('.claude', 'settings.json'),
  local: join('.claude', 'settings.local.json'),
} as const;

/** A settings file this size is not a settings file; refuse to read it. */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSkillOverrideState(value: unknown): value is SkillOverrideState {
  return typeof value === 'string'
    && (SKILL_OVERRIDE_STATES as readonly string[]).includes(value);
}

/**
 * Tolerant parse of one settings document's `skillOverrides` block.
 *
 * Same posture the sibling map-shaped key already states
 * (`builtin-dp-mcp-settings.ts`): a stored map is a record of what the user
 * TOUCHED, never a census of what exists. So an entry whose value is not one of
 * the four documented states is DROPPED rather than fatal — a state written by a
 * newer release must land the skill on the documented default (`"on"`), not take
 * the config layer down. Skill NAMES are passed through unexamined: a name no
 * skill claims is simply never looked up, and refusing unknown names would mean
 * an override written before a skill is installed silently disappears.
 */
export function parseSkillOverrides(config: unknown): ReadonlyMap<string, SkillOverrideState> {
  const overrides = new Map<string, SkillOverrideState>();
  if (!isPlainObject(config)) return overrides;
  const block = config[SKILL_OVERRIDES_SETTING_KEY];
  if (!isPlainObject(block)) return overrides;
  for (const [name, state] of Object.entries(block)) {
    if (name === '__proto__' || name.length === 0) continue;
    if (isSkillOverrideState(state)) overrides.set(name, state);
  }
  return overrides;
}

/**
 * `skills.md:678` — "A skill that is absent from `skillOverrides` is treated as
 * `"on"`." The single place that default lives.
 */
export function resolveSkillOverride(
  overrides: ReadonlyMap<string, SkillOverrideState> | undefined,
  skillName: string,
): SkillOverrideState {
  return overrides?.get(skillName) ?? 'on';
}

/**
 * Merge layers in ascending precedence — later layers win per skill name.
 *
 * `settings.md#settings-precedence` puts Local above Project above User, which
 * is the order the callers pass. Unlike `claudeMdExcludes` (an ARRAY setting,
 * which `settings.md#lists-merge-instead-of-overriding` concatenates across
 * scopes — "When you set the same list key, such as `permissions.allow`, in
 * more than one file, Claude Code combines the lists instead of picking one, so
 * each file can add entries without removing another file's"), this is a scalar
 * per key: a higher scope REPLACES the state rather than adding to it, because
 * there is no "more restrictive" total order over the four states the page
 * states.
 */
export function mergeSkillOverrideLayers(
  ...layers: readonly (ReadonlyMap<string, SkillOverrideState> | undefined)[]
): ReadonlyMap<string, SkillOverrideState> {
  const merged = new Map<string, SkillOverrideState>();
  for (const layer of layers) {
    if (!layer) continue;
    for (const [name, state] of layer) merged.set(name, state);
  }
  return merged;
}

/**
 * One `.claude` settings file's `skillOverrides` block, and NOTHING else out of
 * the document.
 *
 * Read with `parsePermissionJsonc`, the reader `claude-settings-store.ts` and
 * `agent/memory/instruction-excludes.ts` already use for these files, so a
 * document with comments or trailing commas is read the same way by every
 * consumer. Fails open in every failure mode: this file is co-owned with real
 * Claude Code, and a key we do not understand — or a document we cannot parse —
 * must never make capability discovery throw.
 */
function readClaudeSettingsSkillOverrides(path: string): ReadonlyMap<string, SkillOverrideState> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return new Map();
  }
  if (raw.length > MAX_SETTINGS_FILE_BYTES) return new Map();
  try {
    return parseSkillOverrides(parsePermissionJsonc(raw));
  } catch {
    return new Map();
  }
}

export interface SkillOverrideScopesV1 {
  /**
   * The USER scope: an ALREADY-LOADED `config.json` object.
   *
   * Taken rather than read, because the only production caller
   * (`server-core/bootstrap/storage-runtime.ts`) memoizes exactly one
   * `loadStoredConfig()` per resolve and its comment exists to stop a second
   * read.
   */
  readonly userConfig?: unknown;
  /**
   * The project directory whose `.claude/settings.json` and
   * `.claude/settings.local.json` carry the project and local scopes — the
   * destination `skills.md:663` names. Absent = neither scope contributes.
   */
  readonly workingDirectory?: string | undefined;
  /**
   * Repository-owned settings are read ONLY for a trusted project, the same gate
   * `capabilities/native-sources.ts` already applies to these two files. A
   * caller that does not know passes nothing and contributes neither scope.
   */
  readonly projectTrusted?: boolean | undefined;
}

/**
 * Every scope's overrides, merged local > project > user.
 *
 * `settingSources` is deliberately absent: no production caller sets
 * `WorkspacePolicyContext.settingSources` today, so a parameter here would be an
 * unused identifier rather than a control. When that flag becomes real it is one
 * `if` per leg, exactly as `resolveInstructionExcludes` already spells it.
 */
export function resolveSkillOverrides(
  scopes: SkillOverrideScopesV1 = {},
): ReadonlyMap<string, SkillOverrideState> {
  const user = parseSkillOverrides(scopes.userConfig);
  const projectDirectory = scopes.workingDirectory;
  if (!projectDirectory || scopes.projectTrusted !== true) return user;
  return mergeSkillOverrideLayers(
    user,
    readClaudeSettingsSkillOverrides(join(projectDirectory, CLAUDE_SETTINGS_FILES.project)),
    readClaudeSettingsSkillOverrides(join(projectDirectory, CLAUDE_SETTINGS_FILES.local)),
  );
}

/**
 * `skills.md:667`-`:672`, "Listed to Claude: Hidden" — the two states that keep
 * the skill out of the model's `<available_skills>` listing entirely.
 */
export function skillOverrideHidesFromModelListing(state: SkillOverrideState | undefined): boolean {
  return state === 'user-invocable-only' || state === 'off';
}

/**
 * `"name-only"` — "Name only" in the same table. The description is suppressed,
 * the entry stays. `skills.md:949` names the reason this state exists: "To free
 * budget for other skills, set low-priority entries to `"name-only"` in
 * `skillOverrides` so they list without a description" — so the suppression has
 * to happen BEFORE the listing budget is charged, or the state does the opposite
 * of what it is for.
 */
export function skillOverrideHidesDescriptionFromModel(
  state: SkillOverrideState | undefined,
): boolean {
  return state === 'name-only';
}

/**
 * `skills.md:672` ("In `/` menu: Hidden") plus `:676`'s widening of `"off"` to
 * "the command lists advertised to Remote Control clients and to Agent SDK
 * callers, not only the terminal `/` menu".
 *
 * In this fork those two surfaces collapse to ONE: the single
 * `workspace:listCustomSlashCommands` RPC serves the Electron renderer and every
 * remote websocket client alike, and `SessionManager.skillSlashCommands` is its
 * only skill feed.
 */
export function skillOverrideHidesFromCommandLists(state: SkillOverrideState | undefined): boolean {
  return state === 'off';
}

/**
 * THE INVOCATION RULE — one function, both origins, all four states.
 *
 * It is written once because the two halves come from two different sentences
 * and either half alone leaves a hole:
 *
 * - **MODEL origin refuses `"user-invocable-only"` AND `"off"`.** Both are
 *   "Listed to Claude: Hidden" at `skills.md:671`-`:672`, and omission from the
 *   listing is only a HINT — `PromptBuilder.buildSkillListingPart`'s own
 *   docblock already says so, and `resolveSkillReferences` refuses
 *   `disable-model-invocation` for exactly that reason. Refuse only `"off"` and
 *   a model that guesses the slug walks straight through
 *   `"user-invocable-only"`, which is the entire purpose of that state.
 * - **USER origin refuses ONLY `"off"`.** `skills.md:676` — "Invoking a hidden
 *   skill by its full name still returns the `skillOverrides` error instead of
 *   running it" — and `"off"` is the only state the table marks hidden from the
 *   `/` menu. `"user-invocable-only"` must stay UNrefused for the user: keeping
 *   the skill manually invocable is the whole point of the state
 *   (`features-overview.md:227`).
 */
export function skillOverrideRefusesInvocation(
  state: SkillOverrideState | undefined,
  origin: 'user' | 'model',
): boolean {
  if (state === 'off') return true;
  if (state === 'user-invocable-only') return origin === 'model';
  return false;
}

/**
 * C3.326 — the vendor's bundled `/batch`, turned OFF on this fork's claude
 * sessions, on the vendor's own per-skill key.
 *
 * ## What it is, and why it is a posture at all
 *
 * `skills.md#bundled-skills`, verbatim: *"Claude Code includes a set of bundled
 * skills, such as `/doctor`, `/code-review`, `/batch`, `/debug`, `/loop`, and
 * `/claude-api`. Bundled skills are prompt-based: they give Claude detailed
 * instructions and let it orchestrate the work using its tools."*
 *
 * `commands.md#all-commands`, the `/batch` row verbatim: *"Orchestrate
 * large-scale changes across a codebase in parallel. Researches the codebase,
 * decomposes the work into 5 to 30 independent units, and presents a plan. Once
 * approved, spawns one background subagent per unit in an isolated git
 * worktree. Each subagent implements its unit, runs tests, and opens a pull
 * request. Requires a git repository."*
 *
 * The forge write is the terminal step and it is load-bearing rather than
 * optional — W18-e read the skill's own prompt out of the vendored binary and
 * its phase 3 renders a table of `PR` links parsed from each worker's
 * `PR: <url>` line. The product's boundary (owner answer QH2 = B) is that a
 * PERSON opens the merge requests: the host's own fan-out
 * (`packages/server-core/src/pi-harness/worktree-batch-forge-free.ts`
 * (`BATCH_FAN_OUT_REGIONS`)) is machine-checked to contain no forge write at
 * all. So the runtime has the mechanism AND the opposite posture, and leaving
 * both reachable in one product is the silent divergence AGENTS.md
 * §Native-first names.
 *
 * ## Reachability: MEASURED, not assumed (2026-09-12, this is what the row asked for)
 *
 * The row recorded reachability in a gateway session as unmeasured. Driven in
 * P6.125's shape against the VENDORED native binary (self-reports
 * `2.1.247`, SDK `0.3.247`, provenance printed before any number) with the
 * gateway path's own env — `ANTHROPIC_BASE_URL` at a loopback Anthropic Messages
 * stub, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, a throwaway
 * `CLAUDE_CONFIG_DIR`, a throwaway `HOME` so the roster carries nothing of the
 * operator's — reading the child's own `system/init` `slash_commands`:
 *
 * | arm | roster | `batch` |
 * | --- | --- | --- |
 * | baseline, nothing set | 38 | PRESENT |
 * | `skillOverrides: { batch: 'off' }` on the flag tier | 37 | gone |
 * | `disableBundledSkills: true` | 25 | gone, and so are twelve siblings |
 *
 * So `/batch` IS reachable on a gateway session, and the blunt switch
 * (`config/bundled-skills-settings.ts`) would take `deep-research`, `dataviz`,
 * `update-config`, `verify`, `debug`, `code-review`, `simplify`,
 * `fewer-permission-prompts`, `loop`, `claude-api`, `run` and
 * `run-skill-generator` with it.
 *
 * ## Why THIS key and not the shadow the row proposed
 *
 * The row's stated posture was the vendor's shadowing rule,
 * `skills.md#resolve-skills-that-share-a-name`, verbatim: *"Your skill replaces
 * the bundled command, but not its aliases. A project `code-review` skill
 * replaces `/code-review`, and the bundled alias `/review` never runs your
 * skill"*. Two readings moved the answer to the narrower key:
 *
 * 1. **A shadow has nothing to map onto on claude.** The MR-less fan-out is the
 *    `WorktreeBatch` tool, and `packages/session-tools-core/src/tool-defs.ts`
 *    (`WorktreeBatch`) registers it `visibility: 'pi-only'` (re-read at HEAD
 *    2026-09-12), so a shadow `batch` skill on a claude session would be prompt
 *    text describing a fan-out that session has no tool for — more code AND a
 *    worse promise.
 * 2. **`skillOverrides` reaches exactly one skill and is the vendor's own.**
 *    `skills.md#override-skill-visibility-from-settings`, verbatim: *"As of
 *    v2.1.199, `"off"` also hides the skill from the command lists advertised to
 *    Remote Control clients and to Agent SDK callers, in addition to the
 *    terminal `/` menu. Invoking a hidden skill by its full name still returns
 *    the `skillOverrides` error instead of running it."* — so on the SDK path we
 *    drive, `off` both hides it and refuses it.
 *
 * ## The two costs a reader would expect, and both are measured away
 *
 * - **Aliases.** The same page: an alias entry applies only in managed settings
 *   or a `--settings` file, and the shadow rule has the same hole. It is moot
 *   here: `/batch` HAS no alias. Every `aliases:[…]` array in the vendored
 *   binary was read (Python `re.finditer` over the bytes) and none carries
 *   `batch`; `["review"]` for `/code-review` and `["checkup"]` for `/doctor` are
 *   the positive controls that prove the probe reads real alias arrays.
 * - **The user's own `skillOverrides`.** The flag tier could have REPLACED the
 *   user's map. Measured that it does not: a user-tier `{ doctor: 'off' }` alone
 *   gives a roster of 37 without `doctor`, and the same user tier BESIDE this
 *   flag-tier entry gives 36 with neither `doctor` nor `batch` — the two tiers
 *   merge per entry, so a user's own entries survive.
 *
 * ## The residue, stated because it is real
 *
 * There is no operator hatch back to the vendor's `/batch`, which is the same
 * shape `CLAUDE_FEEDBACK_DRAFTS_SETTING` already has: a product posture rather
 * than a per-session fact. An operator who wants it back needs a key of their
 * own and a row of their own, not a widened reading of this one. And the refusal
 * a user meets on typing `/batch` is the vendor's `skillOverrides` error, which
 * names the key and not the reason — {@link CLAUDE_BUNDLED_BATCH_SKILL_DISCLOSURE}
 * is that sentence, and the switch report is where a person reads it.
 */
export const CLAUDE_BUNDLED_BATCH_SKILL_NAME = 'batch'

/**
 * The flag-tier contribution itself. Frozen, and typed through
 * {@link SkillOverrideState} so a value outside the documented four cannot be
 * written here by hand.
 */
export const CLAUDE_BUNDLED_BATCH_SKILL_OVERRIDE: Readonly<{
  readonly skillOverrides: Readonly<Record<string, SkillOverrideState>>
}> = Object.freeze({
  skillOverrides: Object.freeze({ [CLAUDE_BUNDLED_BATCH_SKILL_NAME]: 'off' as SkillOverrideState }),
})

/**
 * ONE sentence saying where `/batch` went, for the surface a person reads.
 *
 * English here, like every other host-side notice in this package: the
 * localized copy belongs to the renderer's switch report, which is the surface
 * that actually shows it.
 */
export const CLAUDE_BUNDLED_BATCH_SKILL_DISCLOSURE =
  "Claude's own /batch is turned off in this product. It ends by opening a pull request from every "
  + 'unit it spawns, and opening merge requests is a person\'s job here. The MR-less fan-out this '
  + 'product ships instead leaves each unit on its own named branch for you to submit, and today it '
  + 'runs on Pi sessions only.'

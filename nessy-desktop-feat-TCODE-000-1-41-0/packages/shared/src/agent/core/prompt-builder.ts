/**
 * PromptBuilder - System Prompt and Context Building
 *
 * Provides utilities for building system prompts and context blocks that both
 * ClaudeAgent and PiAgent can use. Handles workspace capabilities, recovery
 * context, and user preferences formatting.
 *
 * Key responsibilities:
 * - Build workspace capabilities context
 * - Format recovery context for session resume failures
 * - Build session state context blocks
 * - Format user preferences for prompt injection
 */

import { isLocalMcpEnabled } from '../../workspaces/storage.ts';
import { formatPreferencesForPrompt } from '../../config/preferences.ts';
import { workflowSizeGuidanceText, type WorkflowSizeGuideline } from '../../config/workflow-settings.ts';
import {
  skillOverrideHidesDescriptionFromModel,
  skillOverrideHidesFromModelListing,
} from '../../config/skill-overrides.ts';
import { formatSessionState } from '../mode-manager.ts';
import { formatStableGitDeveloperContext, formatVolatileGitDeveloperContext } from '../../prompts/developer-context.ts';
import { getDateTimeContext, getProjectContextFilesPrompt, getWorkingDirectoryContext } from '../../prompts/system.ts';
import { getSessionPlansDir, getSessionDataPath, getSessionDirPath } from '../../sessions/storage.ts';
import { neutralizeHarnessMarkers } from '../../prompts/untrusted-text.ts';
import type { RuntimeSkillHandle } from '../../capabilities/views.ts';
import { resolveNumericSetting } from '../../config/numeric-setting.ts';
import type { RuntimeMcpServer } from '../../capabilities/resolver.ts';
import type { RuntimeExternalAuthRequirement } from '../../mcp/runtime-pool-servers.ts';
import type {
  PromptBuilderConfig,
  ContextBlockOptions,
} from './types.ts';

/**
 * One plugin-owned MCP server the turn DECLARED but could not start, because
 * its global plugin credential slot is empty.
 *
 * Joined by `BaseAgent.setSourceServers` from the two halves that each carry
 * only part of the answer: `materializeRuntimePoolServers`'
 * `externalAuthRequirements` says which wire names are pending and under which
 * provider, and the pinned turn view says which plugin declared each of them.
 * The requirement aggregates `pluginInstanceIds` and `servers` per PROVIDER, so
 * a session with two unauthorized plugins cannot be taken apart from it alone —
 * and the join is what keeps the skill annotation naming the right server.
 */
export interface PendingPluginServerAuth {
  /**
   * `oauth` is fixable inside the turn through `source_oauth_trigger`;
   * `bearer` is a token slot with NO model-facing tool (`credential-prompt.ts`
   * has no plugin target), so its line must not point the model at one.
   *
   * `dp` joined them in C3.381 (owner decision 2026-09-12, option A): the host
   * stopped pausing the turn for a lapsed `dp` CLI session, so the model is now
   * the one that has to answer for the absent tools, and the fix is a command
   * the USER runs (`dp auth login`) — no tool can start it either.
   */
  provider: 'oauth' | 'bearer' | 'dp';
  /** The tool-namespace name whose tools are absent from this turn. */
  wireName: string;
  /** `source_oauth_trigger` argument. Absent for `dp`, which has no such tool. */
  pluginKey?: string;
  /** `source_oauth_trigger` argument; the wire name itself for `dp`. */
  serverName: string;
  /** Declaring plugin, when the view carries one — joins to a skill's bundle. */
  pluginInstanceId?: string;
}

/**
 * Join the turn's pending endpoint-auth requirements to the pinned view that
 * declared the servers.
 *
 * `dp` requirements used to be EXCLUDED here, and the reason was explicit: dp
 * was a hard dependency that `SessionManager.preflightDpAuth` paused the turn
 * for behind an auth card, so repeating it would have told the model to fix
 * something the user was already being asked to fix. C3.381 (owner decision
 * 2026-09-12, option A) ended that pause on every runtime — the gate moved from
 * the TURN to the TOOL — which leaves the model holding a turn whose dp tools
 * are absent with nothing said about why. It is now on the same footing as an
 * unauthorized plugin server: a reminder, naming the sign-in, and nothing more.
 *
 * The dp requirement is shaped differently from the plugin ones and the
 * difference is load-bearing twice over. It carries `wireNames` and no
 * `servers` array (`materializeRuntimePoolServers`,
 * `packages/shared/src/mcp/runtime-pool-servers.ts`), so its lines are built
 * from the wire names; and it aggregates BUILTIN and plugin-bound dp servers
 * into one entry, which the host gates at two different thresholds — a builtin
 * is withheld only at `needs-login`, a plugin-bound dp server at any non-ready
 * state. A line is emitted for exactly the names that are actually missing, so
 * the reminder cannot tell the model a tool is absent while it is in its tool
 * list: that mirror of the two-tier gate (owner decision 2026-08-06) is
 * {@link dpPendingWireNames}.
 */
export function collectPendingPluginServerAuth(
  mcpServers: readonly RuntimeMcpServer[],
  requirements: readonly RuntimeExternalAuthRequirement[],
): PendingPluginServerAuth[] {
  const declaredByWireName = new Map(mcpServers.map(server => [server.wireName, server]));
  const pending: PendingPluginServerAuth[] = [];
  for (const requirement of requirements) {
    if (requirement.state === 'ready') continue;
    if (requirement.provider === 'dp') {
      for (const wireName of dpPendingWireNames(requirement)) {
        const declared = declaredByWireName.get(wireName);
        pending.push({
          provider: 'dp',
          wireName,
          serverName: wireName,
          ...(declared?.pluginInstanceId ? { pluginInstanceId: declared.pluginInstanceId } : {}),
        });
      }
      continue;
    }
    for (const server of requirement.servers ?? []) {
      const declared = declaredByWireName.get(server.wireName);
      pending.push({
        provider: requirement.provider,
        wireName: server.wireName,
        pluginKey: server.pluginKey,
        serverName: server.serverName,
        ...(declared?.pluginInstanceId ? { pluginInstanceId: declared.pluginInstanceId } : {}),
      });
    }
  }
  // Total, locale-independent order: the listing annotation rides Pi's cached
  // system prefix, so the same pending set must always produce the same bytes.
  return pending.sort((a, b) => (a.wireName < b.wireName ? -1 : a.wireName > b.wireName ? 1 : 0));
}

/**
 * The dp wire names whose tools are actually ABSENT from this turn — the
 * mirror, on the model's side, of the host's two-tier dp gate (owner decision
 * 2026-08-06).
 *
 * A builtin dp server carries no credential of its own, so the host withholds
 * it ONLY on a positive `needs-login` verdict and deliberately keeps it
 * connected through a transient `unavailable` (a probe timeout, a dp that could
 * not be spawned). A plugin-bound dp server materializes real credential/argv
 * authority and is skipped at ANY non-ready state. Both thresholds live in
 * `materializeRuntimePoolServers`
 * (`packages/shared/src/mcp/runtime-pool-servers.ts`), and one requirement
 * carries both kinds of name — `builtinWireNames` is what tells them apart.
 *
 * Read against that, not restated from it: a reminder that named a builtin the
 * turn still has would be the worst of the three outcomes, because the model
 * would decline a tool sitting in its own tool list.
 */
function dpPendingWireNames(requirement: RuntimeExternalAuthRequirement): string[] {
  if (requirement.state === 'needs-login') return [...requirement.wireNames];
  const builtin = new Set(requirement.builtinWireNames ?? []);
  return requirement.wireNames.filter(wireName => !builtin.has(wireName));
}

/**
 * Default character budget for the skill listing's DESCRIPTIONS.
 *
 * Every character here is paid on EVERY request of every session, inside Pi's
 * cached system prefix. The bound is deliberately small: a listing is a
 * discovery aid, not documentation — a name, a marker and one line each. 4,000
 * characters is roughly 1,000 input tokens.
 *
 * **It bounds the descriptions, not the listing** (P3.304). Names are
 * unconditional, so the block's floor is one line per invocable skill and that
 * floor is outside this number — which is the contract's own design, not a
 * regression: `skills.md#skill-descriptions-are-cut-short` puts the budget on
 * the descriptions and the names outside it, and a name the model never sees is
 * a skill it cannot invoke by name at all. The operator's lever over the half
 * that IS bounded is {@link SKILL_LISTING_BUDGET_ENV}.
 *
 * ## How this differs from the contract, stated at the scope that is true (P3.72)
 *
 * The ledger cell this constant answers (L10) was written as *"no cap at all,
 * against a documented 2%-or-8,000-character budget"*. The cap is real — this
 * constant, enforced by the accumulate-and-break in
 * {@link PromptBuilder.buildSkillListingPart} — and **both of the cell's numbers
 * are wrong**, measured against the pages on 2026-09-03:
 * `skills.md#skill-descriptions-are-cut-short` says *"The budget scales at 1% of
 * the model's context window"*, `settings-reference.md#skilllistingbudgetfraction`
 * gives **Default: `0.01`, which reserves 1% of the context window** — `0.02` is
 * only that key's raise-it EXAMPLE — and the string `8,000` (or `8000`) occurs in
 * `skills.md` zero times. So the divergence has to be restated rather than
 * closed, and it is FOUR differences, not one:
 *
 *  1. **Shape.** Ours is a flat character constant; the contract is a fraction of
 *     the model's context window. Same 4,000 characters on a 40,960-token gateway
 *     model as on a million-token one — trivial there, a real bite here.
 *  2. ~~**Overflow.**~~ **CLOSED by P3.304.** It used to drop whole ENTRIES at
 *     the budget, so a skill past the cap reached the model as a number and
 *     never as a name. The listing now keeps every name and trims descriptions,
 *     per *"The listing always contains every skill name, but if you have many
 *     skills, Claude Code shortens descriptions to fit the listing's character
 *     budget"*. The half still open is the ORDER — *"drops descriptions starting
 *     with the skills you invoke least"* — which needs a per-skill invocation
 *     counter this tree does not have; the residue is stated at the trim itself.
 *  3. ~~**Not tunable.**~~ **HALF CLOSED by P3.303.**
 *     `SLASH_COMMAND_TOOL_CHAR_BUDGET` is now read here, so the one knob that
 *     already worked on claude-runtime — it is forwarded to the subprocess and
 *     the vendored binary reads it — means the same thing on all three. The two
 *     SETTINGS keys are still unread: `skillListingBudgetFraction` (Default
 *     `0.01`) is difference 1 above, and `skillListingMaxDescChars` (Default
 *     `1536`) is difference 4 below.
 *  4. **Per-entry cap.** Ours is 180 characters against the documented 1,536 —
 *     deliberate, and the reason is on
 *     {@link SKILL_LISTING_DESCRIPTION_MAX_CHARS} below.
 *
 * **Which runtime this changes: ALL THREE, identically, which is the point.**
 * There is one `PromptBuilder` and `BaseAgent` constructs it for every backend,
 * so both P3.303's budget and P3.304's name-keeping land on Pi (in the cached
 * system prefix), on codex (folded onto the outgoing user turn, because the
 * app-server owns the system prompt) and on claude (the same builder's context
 * parts) in the same act. Nothing here decides P3.297 — how skills reach claude
 * is still that row's open posture — and nothing here makes one runtime's
 * listing differ from another's, which is the property a switch depends on.
 *
 * **Codex, read from source rather than assumed (P3.304, `rust-v0.148.0`):** its
 * own skill path has no listing budget to be native-first about.
 * `codex-rs/core/src/skills.rs` (160 lines) and `codex-rs/skills/src/lib.rs`
 * (217 lines) both score **zero** for `budget`/`truncat`/`max_chars`/`limit`,
 * against 60 and 66 hits for `skill` as the positive control that the files were
 * really read. Codex learns about skills only through this listing, so the host
 * is the only place the cap can live for it.
 *
 * ## Why the flat constant is not simply a bug, and what a share would cost
 *
 * A window-share is NOT the ~30-line change the ledger estimated. `PromptBuilder`
 * receives no model and no context window — see the constructor, whose only
 * runtime-dependent input is the `backendNameProvider` thunk, registered that way
 * precisely because subclass fields are not yet initialized when the base builds
 * this — so the window would have to be plumbed in as a second thunk plus a model
 * -metadata read. And it trades against the invariant the listing already carries:
 * the block sits in Pi's CACHED system prefix and is required to be byte-stable
 * across turns (#862). A budget derived from the window makes the listing's size a
 * function of the selected model, so switching models mid-session re-stamps the
 * prefix and invalidates the cached history behind it. That trade — cache
 * stability against a window-proportional budget — is a product posture, so it is
 * stated here rather than decided in passing.
 */
export const SKILL_LISTING_MAX_CHARS = 4_000;

/**
 * The documented operator override for that budget, honoured here (P3.303).
 *
 * `skills.md#skill-descriptions-are-cut-short`, verbatim: *"To raise the budget,
 * set the `skillListingBudgetFraction` setting (e.g. `0.02` = 2%) or the
 * `SLASH_COMMAND_TOOL_CHAR_BUDGET` environment variable **to a fixed character
 * count**."* (Anchor verified against the rendered page, 2026-09-03.)
 *
 * ## Why THIS half of the contract is wired and the fraction is not
 *
 * A fixed character count is the shape this budget already has, so honouring it
 * costs nothing the listing was not already paying: no model, no context window,
 * and the block stays byte-stable across turns inside Pi's cached system prefix
 * (#862). The fraction is the half that would need the window plumbed in and
 * would make the listing's size a function of the selected model; that trade is
 * still open above.
 *
 * ## The divergence this closes, which was worse than an absent knob
 *
 * The variable was already FORWARDED to the claude subprocess and read by the
 * vendored binary — `buildClaudeSubprocessEnv`, pinned by
 * `__tests__/claude-operator-ceiling-env.test.ts`'s `OTHER_CEILINGS`, whose
 * header says every name in that list is verified present in the vendored
 * 2.1.223 binary. So an operator who set it moved the SDK's own listing on
 * claude-runtime and moved nothing on Pi or codex: one setting, two meanings
 * either side of a runtime switch, with nothing reporting the difference. It is
 * read here, in the single `PromptBuilder` every backend constructs, so the
 * answer is now the same on all three.
 *
 * The two SETTINGS keys are still unread and that is a stated residue, not an
 * oversight: `skillListingBudgetFraction` is the fraction half above, and
 * `skillListingMaxDescChars` (default `1536`) is the per-entry cap whose
 * deliberate 180-character divergence is reasoned at
 * {@link SKILL_LISTING_DESCRIPTION_MAX_CHARS}.
 *
 * **P6.477 — and the residue now MEETS the operator, which is the half this
 * paragraph could not supply.** A residue stated only in a source comment is
 * invisible to the person who set the key, which is the half-true-disclosure
 * shape this fork keeps finding. `apps/cli/src/doctor.ts` carries the line
 * (`SKILL_LISTING_BUDGET_DOCTOR`, landed `3084bf664`): an operator who set
 * `skillListingBudgetFraction` is told that this build's listing does not read it
 * and is given the two channels that ARE read —
 * {@link SKILL_LISTING_MAX_CHARS} and {@link SKILL_LISTING_BUDGET_ENV} — by name.
 * It reads BOTH values out of this module's own source, so the doctor and the
 * budget cannot drift into two answers, and it never moves the exit code: an
 * unread documented key is a disclosure, not a fault.
 *
 * **There is exactly ONE such disclosure and it lives there, not here.** Owner
 * decision Q5 (2026-09-05) is option A — keep the flat character budget — so
 * this module's job is to be the single place the two numbers are defined, and
 * the doctor's is to be the single place the operator meets them. A second
 * notice on this side would be the same fact told twice in two voices, which is
 * how two disclosures come to disagree.
 */
export const SKILL_LISTING_BUDGET_ENV = 'SLASH_COMMAND_TOOL_CHAR_BUDGET';

/**
 * The listing's description budget for this process.
 *
 * A malformed or zero value takes the default rather than collapsing the budget
 * to nothing — the same rule `resolveBashReadBackChars` applies to the other
 * documented operator ceilings, and for the same reason: an operator typo must
 * not silently empty a window. No upper clamp, because the page states no
 * ceiling for this variable (it does for `BASH_MAX_OUTPUT_LENGTH`, which is why
 * that one is clamped and this one is not).
 */
export function resolveSkillListingBudgetChars(
  env: Record<string, string | undefined> = process.env,
): number {
  // P6.565 · GENERAL rule, routed by this key's own page row.
  // `env-vars.md#variables` grants scientific notation and digit separators to
  // every numeric variable "except where a variable's row notes it takes plain
  // digits only", and `SLASH_COMMAND_TOOL_CHAR_BUDGET`'s row notes nothing of
  // the kind — it says only what the budget is for and that the name is legacy.
  // So `2e3` and `8_000` are legal spellings; the `/^\d+$/` this replaced was the
  // house convention applied without reading the row.
  const value = resolveNumericSetting(
    SKILL_LISTING_BUDGET_ENV,
    env[SKILL_LISTING_BUDGET_ENV],
    SKILL_LISTING_MAX_CHARS,
  );
  // Zero keeps the default rather than collapsing the listing to nothing. Not a
  // rejection, so it is not reported: `0` is a value this key does not honour.
  return value === 0 ? SKILL_LISTING_MAX_CHARS : value;
}

/**
 * Per-entry description bound. Claude truncates a skill's `description` (plus
 * `when_to_use`) at 1,536 characters in its own listing, but that is a
 * per-entry cap against a much larger listing budget; here one verbose skill
 * must not be able to consume the whole block, so an entry gets one line.
 */
const SKILL_LISTING_DESCRIPTION_MAX_CHARS = 180;

/**
 * The reference a model must emit to invoke this skill. Mirrors how
 * `BaseAgent.extractSkillInvocations` resolves a marker: the short alias when
 * the resolver selected it, the DIRECTORY-QUALIFIED name for a nested skill that
 * did not get the short one, otherwise the fully-qualified key. Listing the
 * wrong one would produce markers that never resolve.
 *
 * `skills.md:128` — the nested variant "appears under a directory-qualified
 * name, `apps/web:deploy`". Before R79 a collision loser was listed under its raw
 * internal capability key (`skill::project::<ws>::<pk>::d1::deploy`), which the
 * model could copy but no human could read.
 *
 * ## ONE HOST MARKER FOR THREE RUNTIMES — the decision, recorded (P6.38)
 *
 * The marker spelled here, `[skill:<reference>]`, is the host's own and is the
 * ONLY invocation vocabulary any of the three runtimes is given. That is a
 * deliberate share, not an oversight, and it was previously written down nowhere
 * — which is the whole of ledger row L11. Each vendor spells the same act
 * differently, and none of those spellings resolves here:
 *
 *   | Where | Spelling |
 *   | --- | --- |
 *   | Claude | `/skill-name`, and `/plugin:skill` for a plugin skill (`skills.md#control-who-invokes-a-skill`: "You can type `/skill-name` to invoke it directly") |
 *   | Codex | `$skill-name` (`developers.openai.com/plugins/build/skills.md`: "In Codex, invoke the same creator as `$skill-creator`" — vendor page, so intent rather than measured binary behaviour) |
 *   | ChatGPT | `@skill-name` (same page) |
 *   | Here | `[skill:<reference>]` — this function, resolved by `BaseAgent.extractSkillInvocations` and `mentions/index.ts` |
 *
 * WHY ONE: the host owns the skill catalog for all three backends (there is no
 * per-runtime skill materialisation — codex is told about skills only through
 * this listing), so a second vocabulary would be three parsers for one act and a
 * new switch-visible divergence, which is the failure this fork is closing rather
 * than adding to. The share is `UNIFORM` by construction: a session that switches
 * runtime keeps the same marker.
 *
 * THE COST, stated because it is user-visible: a user who copy-pastes a vendor's
 * own prompt template — they read literally `Use $codex-security:triage-finding
 * to …` — gets plain text that resolves to nothing. Accepting the vendors'
 * spellings as ALIASES is a product decision (a new user-facing invocation
 * syntax, and `$`/`@`/`/` all carry existing meanings in a prompt), so it was
 * left open here rather than taken quietly.
 *
 * DECIDED, owner Q6 on 2026-09-05 (P6.478): **option B — detect and tell, do not
 * resolve.** Option C, the aliases, stays refused: the invocation vocabulary
 * remains single, so a runtime switch cannot change how a skill is invoked. What
 * changed is that the silence is gone — `buildSkillListingPart`'s header now
 * names the three vendor spellings and tells the model to answer a message that
 * uses one for a LISTED skill with the marker this session actually uses.
 * The trade that shape accepts, and why it is not a scanner, is recorded at that
 * header.
 */
function skillListingReference(skill: RuntimeSkillHandle): string {
  if (skill.selectedAsUnqualifiedAlias) return skill.logicalName;
  if (skill.directoryQualifier) return `${skill.directoryQualifier}:${skill.logicalName}`;
  return skill.key;
}

/** One-line, bounded, newline-free description text for a listing entry. */
function boundedListingText(value: string): string {
  const flattened = value.replace(/\s+/g, ' ').trim();
  return flattened.length > SKILL_LISTING_DESCRIPTION_MAX_CHARS
    ? `${flattened.slice(0, SKILL_LISTING_DESCRIPTION_MAX_CHARS - 1)}…`
    : flattened;
}

/**
 * PromptBuilder provides utilities for building prompts and context blocks.
 *
 * Usage:
 * ```typescript
 * const promptBuilder = new PromptBuilder({
 *   workspace,
 *   session,
 *   debugMode: { enabled: true },
 * });
 *
 * // Build context blocks for a user message
 * const contextParts = promptBuilder.buildContextParts({
 *   permissionMode: 'plan',
 *   plansFolderPath: '/path/to/plans',
 * });
 * ```
 */
export class PromptBuilder {
  private config: PromptBuilderConfig;
  private workspaceRootPath: string;
  private workspaceId: string;
  private pinnedPreferencesPrompt: string | null = null;
  private capabilityRuntimeActive = false;
  private runtimeSkills: readonly RuntimeSkillHandle[] = [];
  private pendingPluginServerAuth: readonly PendingPluginServerAuth[] = [];
  private workflowSizeGuideline: WorkflowSizeGuideline = 'unrestricted';
  private activeOutputStyleLabel: string | null = null;
  /** UB12.21 — see {@link setActiveOutputStyle}'s `switchNotices`. */
  private outputStyleSwitchNotices = false;
  /**
   * UB7.1 — the stable git developer context, cached by working directory
   * (upstream's `stableDeveloperContextCache`): the repo identity is invariant
   * across a session, so it belongs in the cached prefix and must not re-run
   * its git calls every turn.
   */
  private stableDeveloperContextCache: { workingDirectory: string | undefined; value: string | null } | null = null;
  /**
   * P3.238 — how the session-state block learns which runtime this turn runs
   * on, so `formatModeGuidance` can stop telling a codex model that its edits
   * are blocked and to call a tool codex never advertises.
   *
   * A PROVIDER rather than a value, and that is the whole reason it is a setter
   * and not a `PromptBuilderConfig` field: `BaseAgent.backendName` is a subclass
   * field, and subclass field initializers run AFTER `super()` returns, so
   * anything read during the base constructor — where this builder is
   * constructed — reads `undefined`. The thunk is registered there and invoked
   * at turn time, by which point the subclass is fully initialized.
   *
   * Unset means the runtime-independent wording, which is the correct answer for
   * a builder nobody registered one on.
   */
  private backendNameProvider: (() => string) | undefined;

  constructor(config: PromptBuilderConfig) {
    this.config = config;
    this.workspaceRootPath = config.workspace.workspaceRootPath;
    this.workspaceId = config.workspace?.id ?? '';
  }

  // ============================================================
  // Context Building
  // ============================================================

  /**
   * Build all context parts for a user message (volatile blocks first, then
   * stable blocks). Returns an array of strings that should be prepended to the
   * user message.
   *
   * This is the Claude path: it composes {@link buildVolatileContextParts} and
   * {@link buildStableContextParts} so the output is byte-identical to the
   * pre-split version (same 5 blocks, same order) AND the one-shot mode-change
   * signal is consumed exactly once per turn (only the volatile builder consumes
   * it). Callers that place volatile vs stable context in different locations
   * (e.g. the Pi adapter, to preserve prompt caching — issue #862) should call
   * the two halves directly instead of this method.
   *
   * @param options - Context building options
   * @param sourceStateBlock - Pre-formatted source state (from SourceManager)
   * @returns Array of context strings
   */
  buildContextParts(
    options: ContextBlockOptions,
    sourceStateBlock?: string
  ): string[] {
    return [
      ...this.buildVolatileContextParts(options, sourceStateBlock),
      ...this.buildStableContextParts(),
    ];
  }

  /**
   * Volatile context blocks — content that can change every turn, so it must
   * ride the user-message tail rather than the cached system prefix (issue
   * #862). Folding these into the system prompt re-stamps the cache prefix each
   * turn and kills prompt-cache reuse for all downstream history.
   *
   * Blocks (in order):
   *  1. date/time (minute precision)
   *  2. session_state (permission mode + plans/data paths; carries
   *     modeChangedAt/modeVersion and **consumes** the one-shot mode-change user
   *     signal — see {@link formatSessionState})
   *  3. source state (auth/connection status), when provided
   *  4. project context file content, when present in the working directory
   *
   * MUST be called exactly once per turn, because it consumes one-shot mode
   * state. Never call it a second time to compute a cache-debug hash — hash the
   * already-produced string instead.
   *
   * @param options - Context building options
   * @param sourceStateBlock - Pre-formatted source state (from SourceManager)
   */
  buildVolatileContextParts(
    options: ContextBlockOptions,
    sourceStateBlock?: string
  ): string[] {
    const parts: string[] = [];

    // Date/time first (kept on the user tail to preserve prompt caching)
    parts.push(getDateTimeContext());

    // Session state (permission mode, plans folder path, data folder path).
    // Only this volatile builder may consume the one-shot mode-change signal. F1.743: `omitSessionState` (a Guardian judge) composes none.
    const sessionId = this.config.session?.id ?? `temp-${Date.now()}`;
    const plansFolderPath = options.plansFolderPath ??
      getSessionPlansDir(this.workspaceId, sessionId);
    const dataFolderPath = options.dataFolderPath ??
      getSessionDataPath(this.workspaceId, sessionId);
    if (!options.omitSessionState) parts.push(formatSessionState({ workspaceId: this.config.workspace?.id ?? '', sessionId }, {
      plansFolderPath,
      dataFolderPath,
      consumeModeChangeUserSignal: true,
      // P3.238 — the mode guidance is the one block in here whose truth depends
      // on the runtime; a thunk that throws must not cost the turn its whole
      // session-state block, so an unavailable name degrades to the
      // runtime-independent wording (what shipped before this row).
      backendName: this.resolveBackendName(),
    }));

    // Source state if provided
    if (sourceStateBlock) {
      parts.push(sourceStateBlock);
    }

    // UB7.1 — the developer git context's volatile half: branch, upstream and
    // the bounded worktree counts, re-read EVERY turn (upstream's placement —
    // after source state, in the volatile builder). Null outside a repo, so a
    // session whose working directory is not a checkout composes byte-identical
    // parts. Not cached: this is the block whose truth changes mid-session.
    const volatileDeveloperContext = this.getVolatileDeveloperContext();
    if (volatileDeveloperContext) {
      parts.push(volatileDeveloperContext);
    }

    // A declared plugin MCP server whose credential slot is empty. VOLATILE:
    // the block disappears the moment the user signs in, and folding that into
    // Pi's cached system prefix would re-stamp it (#862).
    const pendingPluginAuth = this.buildPendingPluginAuthReminder();
    if (pendingPluginAuth) {
      parts.push(pendingPluginAuth);
    }

    // `output-styles.md:101` — the during-the-conversation reminder for the
    // active output style. VOLATILE: the style prose already lives in the
    // cached system prefix, so this must ride the user tail to be a second
    // injection point rather than a prefix re-stamp (#862). Emits nothing for
    // Default or when no style is active.
    const outputStyleReminder = this.buildOutputStyleReminder();
    if (outputStyleReminder) {
      parts.push(outputStyleReminder);
    }

    // Project context files (AGENTS.md, CLAUDE*) are repository-owned and load
    // only from a trusted project workingDirectory (W6, fail-closed).
    if (!this.capabilityRuntimeActive && this.config.projectTrusted === true) {
      const projectContextFile = getProjectContextFilesPrompt(this.config.session?.workingDirectory);
      if (projectContextFile) {
        parts.push(projectContextFile);
      }
    }

    return parts;
  }

  /**
   * Stable context blocks — content that is invariant across a session, so it
   * can safely live in the cached system prefix (issue #862).
   *
   * Blocks (in order):
   *  1. workspace capabilities
   *  2. working directory, when available
   *  3. the model-invocable skill listing, when there is one
   *  4. the workflow size guideline, when one is set
   *
   * Pure and idempotent: holds no one-shot state, so it is safe to call any
   * number of times per turn.
   */
  buildStableContextParts(options: StableContextPartsOptions = {}): string[] {
    const parts: string[] = [];

    // Workspace capabilities
    parts.push(this.formatWorkspaceCapabilities());

    // Working directory context
    const workingDirContext = this.getWorkingDirectoryContext(options);
    if (workingDirContext) {
      parts.push(workingDirContext);
    }

    // UB7.1 — the developer git context's stable half: repo identity and the
    // git guidance, invariant across a session and cached by working directory
    // (upstream's placement — after the working-directory block, before the
    // variable listings). Null outside a repo, so a session in a plain folder
    // keeps byte-identical prefix bytes.
    const stableDeveloperContext = this.getStableDeveloperContext();
    if (stableDeveloperContext) {
      parts.push(stableDeveloperContext);
    }

    // Skill listing last, so a session with no skills keeps byte-identical
    // prefix bytes to the pre-P7 build.
    const skillListing = this.buildSkillListingPart();
    if (skillListing) {
      parts.push(skillListing);
    }

    // Workflow size guideline. Emitted only when a non-default value is set, so
    // the default session keeps byte-identical prefix bytes.
    const guidance = workflowSizeGuidanceText(this.workflowSizeGuideline);
    if (guidance) {
      parts.push(`<workflow_size_guideline>\n${guidance}\n</workflow_size_guideline>`);
    }

    return parts;
  }

  /**
   * UB7.1 — the stable git developer context (repo identity + git guidance),
   * cached by working directory so repeated turns inside one checkout do not
   * re-run the git calls. `null` outside a repository; the working directory is
   * the selected session `workingDirectory`, upstream's
   * `getSelectedWorkingDirectory` reading.
   */
  getStableDeveloperContext(): string | null {
    const workingDirectory = this.config.session?.workingDirectory;
    const cached = this.stableDeveloperContextCache;
    if (cached && cached.workingDirectory === workingDirectory) {
      return cached.value;
    }
    const value = formatStableGitDeveloperContext(workingDirectory);
    this.stableDeveloperContextCache = { workingDirectory, value };
    return value;
  }

  /**
   * UB7.1 — the volatile git developer context (branch, upstream, worktree
   * counts), re-computed every turn and never cached: its truth changes
   * mid-session by design. `null` outside a repository.
   */
  getVolatileDeveloperContext(): string | null {
    return formatVolatileGitDeveloperContext(this.config.session?.workingDirectory);
  }

  /**
   * The session's resolved workflow size guideline.
   *
   * ADVICE ONLY. `workflows.md` §Set a size guideline: "Claude Code sends the
   * guideline to Claude as advice, not a cap, so a prompt that calls for a
   * different scale still overrides it." Nothing downstream may read this to
   * bound, trim, or refuse a run — the runtime agent caps are separate.
   *
   * It lives on the prompt rather than the workflow tool's description because
   * the tool's model contract is hash-pinned (`PI_STATIC_MODEL_CONTRACT_HASHES`),
   * so a per-session description would break manifest projection.
   */
  setWorkflowSizeGuideline(guideline: WorkflowSizeGuideline): void {
    this.workflowSizeGuideline = guideline;
  }

  /**
   * The pinned skill set for this session's capability generation. Fed from
   * `BaseAgent.setCapabilityTurnRuntime`, never read from disk here — the
   * handles already carry the pinned description and control fields.
   */
  setRuntimeSkills(skills: readonly RuntimeSkillHandle[]): void {
    this.runtimeSkills = skills;
  }

  /**
   * The turn's unauthorized plugin MCP servers, published by
   * `BaseAgent.setSourceServers` from the `externalAuthRequirements` the
   * materialization returns.
   *
   * An empty list emits no reminder and no listing annotation, so a session
   * with nothing pending keeps byte-identical prompt bytes.
   */
  setPendingPluginServerAuth(pending: readonly PendingPluginServerAuth[]): void {
    this.pendingPluginServerAuth = pending;
  }

  /**
   * The label of the output style whose prose the current system prompt
   * carries, or `null` when no style contributes any (Default, an unresolvable
   * id, a named subagent).
   *
   * Fed once per turn by the backend from the SAME child-kind-guarded
   * resolution the system prompt uses (`resolveChildOutputStyleId`), which is
   * what keeps a named subagent reminder-free per `output-styles.md:104` while
   * a fork keeps the reminder. A plain label, never a style id: the builder
   * must not re-walk the style directories per turn.
   *
   * UB12.21 — `switchNotices` is for a runtime whose system prompt is recorded
   * once per conversation (Claude, UB2.13's `snapshot: true`). There a style
   * picked mid-session reaches the model as a one-shot notice on the turn's
   * tail (`core/output-style-switch.ts`), not through the system prompt, so the
   * reminder must not say the instructions are in the system prompt. Unset
   * keeps the wording Pi and codex have always received, byte for byte.
   */
  setActiveOutputStyle(label: string | null, options: { switchNotices?: boolean } = {}): void {
    this.activeOutputStyleLabel = label;
    this.outputStyleSwitchNotices = options.switchNotices === true;
  }

  /**
   * Mid-turn notice that a declared MCP server exists but is not signed in.
   *
   * The user already gets a session-START signal (`PendingAuthNotice`); what was
   * missing is any signal INSIDE the turn. The pool skips such a server, so its
   * tools are simply absent from the tool list and the model reports a broken
   * plugin.
   *
   * NON-INTERRUPTING by design — and since C3.381 (owner decision 2026-09-12,
   * option A) that is true of dp too: `SessionManager.preflightDpAuth` used to
   * pause the turn for a lapsed `dp` CLI session and no longer does on any
   * runtime, so this block is where the model learns that a dp tool is missing
   * and what the USER has to run. `dp auth login` is named as the user's
   * command, never as something to try: no tool can start it, exactly as the
   * `bearer` line is careful not to point at `source_oauth_trigger`.
   *
   * Server and plugin identifiers are plugin-authored text, so they are defanged
   * on the way in: a server named `</system-reminder>` must not be able to close
   * the host's own block.
   */
  buildPendingPluginAuthReminder(): string | undefined {
    if (this.pendingPluginServerAuth.length === 0) return undefined;
    const lines = this.pendingPluginServerAuth.map(entry => {
      const serverName = neutralizeHarnessMarkers(entry.serverName);
      if (entry.provider === 'dp') {
        return `- '${serverName}' needs a Developer Platform sign-in; no tool can`
          + " start one, so tell the user to run 'dp auth login' and say that this"
          + ' is why the tool is unavailable.';
      }
      if (entry.provider !== 'oauth') {
        return `- '${serverName}' needs an API token in its plugin's settings;`
          + ' no tool can set one, so ask the user to add it.';
      }
      const pluginKey = neutralizeHarnessMarkers(entry.pluginKey ?? '');
      return `- '${serverName}' needs a sign-in: call source_oauth_trigger with`
        + ` pluginKey ${JSON.stringify(pluginKey)} and serverName ${JSON.stringify(serverName)}.`;
    });
    return '<system-reminder>\n'
      + 'These MCP servers are installed but not authenticated, so their tools are'
      + ' absent from your tool list this turn. That is a missing sign-in, not a'
      + ' broken plugin — say so instead of reporting the plugin as broken.\n'
      + `${lines.join('\n')}\n`
      + 'Everything else in this turn works normally; do not stop or pause for this.\n'
      + '</system-reminder>';
  }

  /**
   * Per-turn restatement that an output style is active.
   *
   * `output-styles.md:101` — "All output styles trigger reminders for Claude to
   * adhere to the output style instructions during the conversation." The style
   * body itself rides the system prompt (`:100`); this block is the second,
   * during-the-conversation injection point, naming the style rather than
   * repeating it. On a runtime that set `switchNotices` (Claude, UB12.21) the
   * body of a style picked mid-session arrives as a notice instead, and the
   * wording points at the latest block rather than at the system prompt.
   *
   * Emitted from {@link buildVolatileContextParts} ONLY. The style prose is
   * already inside Pi's cached system prefix, so a stable placement would add
   * bytes without adding a second injection point (#862).
   *
   * A custom or plugin style's label is author-controlled text riding inside
   * the host's own fence, so it is defanged: a style named
   * `</system-reminder>…` must not be able to close the host's block.
   */
  buildOutputStyleReminder(): string | undefined {
    const label = this.activeOutputStyleLabel?.trim();
    if (!label) return undefined;
    const safeLabel = neutralizeHarnessMarkers(label);
    const where = this.outputStyleSwitchNotices
      ? ' are in the latest "Output Style:" block you received (in your system prompt,'
        + ' or in a later output-style notice that replaced it)'
      : ' are in your system prompt under "Output Style:"';
    return '<system-reminder>\n'
      + `The '${safeLabel}' output style is active. Its response-style instructions`
      + `${where} — keep adhering to them`
      + ' for this and every reply in this conversation.\n'
      + '</system-reminder>';
  }

  /**
   * Bounded listing of the skills the MODEL may invoke, for the stable context
   * part.
   *
   * Two invariants:
   *  - **Byte-stable across turns.** Sorting is total and locale-independent
   *    (code-unit order on `key`, which is unique), so the same skill set always
   *    produces the same bytes regardless of the order the view arrived in. An
   *    unstable listing would re-stamp Pi's cached system prefix every turn and
   *    invalidate all downstream history (#862).
   *  - **`disable-model-invocation` omits the entry.** That is only a hint on
   *    its own; the invocation path refuses the same skill (see
   *    `BaseAgent.extractModelSkillInvocations`), which is what makes it a
   *    control. `user-invocable: false` restricts the human, not the model, so
   *    those skills stay listed — matching the documented behaviour that their
   *    description is always in context.
   *
   * A skill with no description is still listed by name: Claude has an explicit
   * name-only listing state, and the name alone is a usable discovery aid.
   *
   * `skillOverrides` (`skills.md:663`, R61) is the SETTINGS-side control over
   * the same two columns, and it lands here twice: the two states the table at
   * `:667`-`:672` marks "Listed to Claude: Hidden" drop out entirely, and
   * `"name-only"` keeps the entry while suppressing its description. The
   * suppression happens BEFORE the description budget is charged because
   * `skills.md:949` names freeing listing budget as the reason that state
   * exists — charging the full line and then printing a short one would invert
   * it. That state and the budget trim now produce the SAME shape, deliberately:
   * a name-only entry is what the settings key asks for and what an overflowing
   * budget falls back to, so a reader meets one rendering rather than two.
   */
  buildSkillListingPart(): string | undefined {
    const invocable = this.runtimeSkills
      .filter(skill => skill.disableModelInvocation !== true)
      .filter(skill => !skillOverrideHidesFromModelListing(skill.overrideState))
      // `key` is unique per capability, so this comparison is total. Plain
      // relational operators, not `localeCompare`, so the order cannot shift
      // with the host locale.
      .slice()
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (invocable.length === 0) return undefined;

    const header = '<available_skills>\n'
      + 'Skills you can invoke yourself. To use one, emit its marker (for example'
      + ' [skill:review]) in your reply; its full instructions are then loaded for'
      + ' you before you continue. Invoke a skill whenever its description matches'
      + ' the work at hand — the user does not have to name it.\n'
      // P6.478 / ledger L11, owner decision Q6 (2026-09-05): option B — DETECT
      // AND TELL, do not resolve. Option C, accepting the vendors' spellings as
      // aliases, stays refused, so no second invocation syntax is minted here.
      //
      // The cost this pays off is stated at `skillListingReference` above: a
      // user who pastes a vendor's own prompt template writes `/plugin:skill`,
      // `$skill-name` or `@skill`, none of which resolves here, and until now
      // nothing said so — the text was simply inert.
      //
      // WHY THE INSTRUCTION AND NOT A SCANNER, said plainly because it is a
      // real trade. A deterministic scan would need the user's message text,
      // and `PromptBuilder` never sees it: `buildVolatileContextParts` takes
      // paths, and the only caller with the turn text is `BaseAgent`. Wiring it
      // through would add a per-turn parameter and a second parser for an act
      // that already has one, against an owner rule that asks for the smallest
      // integration. So the detection is the model's and the VOCABULARY is
      // ours — stated once, identically on all three runtimes.
      //
      // It is conditioned on a skill LISTED ABOVE, which is also what keeps the
      // false positives out: `$VAR`, `@user` and a path like `src/a/b` name no
      // listed skill, so nothing fires on them.
      //
      // Byte-stable, so it is safe inside Pi's cached system prefix (#862):
      // this text does not depend on the turn, the model or the session.
      + 'Other tools spell this act differently — `/name` and `/plugin:name` in'
      + ' Claude Code, `$name` in Codex, `@name` in ChatGPT — and none of those'
      + ' resolves here. If a message uses one of those spellings for a skill'
      + ' listed below, do not treat it as an unknown command: say once that this'
      + ' session invokes it as [skill:<name>], then continue with the work.\n';
    const footerTag = '</available_skills>';

    // Every entry's NAME line, built for all of them before anything is
    // budgeted. `skills.md#skill-descriptions-are-cut-short`, verbatim: *"The
    // listing always contains every skill name, but if you have many skills,
    // Claude Code shortens descriptions to fit the listing's character
    // budget"*. So the budget bounds the DESCRIPTIONS and the names sit outside
    // it (P3.304).
    const entries = invocable.map(skill => {
      // `paths` (`skills.md:267`) is stated, not applied, here. Filtering the
      // listing by which files the turn happened to touch would re-stamp Pi's
      // cached system prefix on every turn (#862) and make the model believe
      // the skill does not exist; the invocation path is what enforces it.
      const paths = skill.paths?.length ? ` [only while working with ${skill.paths.join(' ')}]` : '';
      // `skills.md:129-130` — for a nested variant, "Its description says which
      // directory it applies to" so that "Claude picks the variant that matches
      // the files it is working on". Stated on the same annotation rail as
      // `paths` rather than rewritten into the author's description, so the text
      // the Skills UI shows stays the author's own.
      const ownedBy = skill.directoryQualifier ? ` [owned by ${skill.directoryQualifier}/]` : '';
      const pendingAuth = this.pendingAuthAnnotation(skill);
      const describe = skill.description
        && !skillOverrideHidesDescriptionFromModel(skill.overrideState);
      return {
        // The annotations ride the NAME line rather than the description: each
        // one explains why a listed skill may not behave as the model expects
        // (a path restriction, an owning directory, an unauthenticated server),
        // and a trimmed entry needs that more than an untrimmed one, not less.
        nameLine: `- [skill:${skillListingReference(skill)}]${paths}${ownedBy}${pendingAuth}`,
        description: describe ? ` — ${boundedListingText(skill.description)}` : '',
      };
    });

    const budget = resolveSkillListingBudgetChars();
    let used = entries.reduce((total, entry) => total + entry.nameLine.length + 1, 0);
    let trimmed = 0;
    // Descriptions are added in the SAME total, locale-independent key order the
    // listing itself uses, so the ones that fit are a stable prefix and the
    // block stays byte-identical across turns.
    //
    // RESIDUE, stated because the page specifies the other half: *"Claude Code
    // drops descriptions starting with the skills you invoke least, so the
    // skills you use most keep their full text"*. Nothing in this tree counts
    // per-skill invocations, so "least invoked" has no input here and key order
    // is what replaces it. Adopting the documented priority needs a counter
    // first, and a counter would make the listing depend on session history —
    // which is exactly what #862 forbids inside the cached prefix.
    const lines = entries.map(entry => {
      if (!entry.description) return entry.nameLine;
      if (used + entry.description.length > budget) {
        trimmed += 1;
        return entry.nameLine;
      }
      used += entry.description.length;
      return `${entry.nameLine}${entry.description}`;
    });

    // Truthful, and about the thing that actually happened. This used to read
    // "(N more skills not listed — ask the user which to use.)", which was the
    // honest report of a listing that dropped whole entries: a skill past the
    // budget reached the model as a number and never as a name, so it could not
    // be invoked by name at all. Nothing is dropped now, so the notice says what
    // is missing instead — the descriptions — and stops implying the library is
    // hidden.
    const overflow = trimmed > 0
      ? `\n(${trimmed} skill${trimmed === 1 ? '' : 's'} listed by name only — the listing's description budget is full.)`
      : '';

    return `${header}${lines.join('\n')}${overflow}\n${footerTag}`;
  }

  /**
   * `[server 'figma' needs sign-in]` on a skill whose OWN plugin declared an MCP
   * server this turn could not authenticate.
   *
   * Without it the ordering is inverted against the user: eight of figma's
   * twelve skill descriptions name a Figma MCP tool, all twelve reach the system
   * prompt, and the servers materialize to none — so the model is primed to call
   * tools that are not in its tool list, and the user reads the result as a
   * broken plugin rather than a missing sign-in.
   *
   * Matched on the DECLARING plugin instance, never on name similarity: a skill
   * gets the marker only when the pending server rode the same plugin bundle it
   * did. A native skill and another plugin's skill are untouched.
   */
  private pendingAuthAnnotation(skill: RuntimeSkillHandle): string {
    if (this.pendingPluginServerAuth.length === 0) return '';
    const resource = skill.resource;
    if (!('pluginInstanceId' in resource)) return '';
    const names = [...new Set(
      this.pendingPluginServerAuth
        .filter(entry => entry.pluginInstanceId === resource.pluginInstanceId)
        .map(entry => neutralizeHarnessMarkers(entry.serverName)),
    )].sort();
    if (names.length === 0) return '';
    const quoted = names.map(name => `'${name}'`).join(', ');
    return names.length === 1
      ? ` [server ${quoted} needs sign-in]`
      : ` [servers ${quoted} need sign-in]`;
  }

  /**
   * Format workspace capabilities for prompt injection.
   * Informs the agent about what features are available in this workspace.
   */
  formatWorkspaceCapabilities(): string {
    if (this.capabilityRuntimeActive) {
      return '<workspace_capabilities>resolved by pinned capability generation</workspace_capabilities>';
    }
    const capabilities: string[] = [];

    // Check local MCP server capability
    const localMcpEnabled = isLocalMcpEnabled(this.workspaceRootPath);
    if (localMcpEnabled) {
      capabilities.push('local-mcp: enabled (stdio subprocess servers supported)');
    } else {
      capabilities.push('local-mcp: disabled (only HTTP/SSE servers)');
    }

    return `<workspace_capabilities>\n${capabilities.join('\n')}\n</workspace_capabilities>`;
  }

  /**
   * Get working directory context for prompt injection.
   *
   * ## D1.141 — this does NOT read `BaseAgent.workingDirectory`, and that is the
   * whole answer to the row's model-facing half
   *
   * The hand-off this lane received says the model is told the WORKSPACE ROOT,
   * because `base-agent.ts` sets `this.workingDirectory =
   * config.session?.workingDirectory ?? config.workspace.workspaceRootPath`
   * while the claude child spawns in `sdkCwd ?? getSessionDirPath(...)`.
   * Measured at this seam, the premise does not reach the prompt: the block
   * below composes its OWN value, `session?.workingDirectory ??
   * getSessionDirPath(workspaceId, sessionId)` — the same session-store fallback
   * the child uses — and `this.workingDirectory` appears nowhere in any prompt
   * block (it is the CD-rule subject, `mutateWorkingDirectory`'s base and what
   * the picker displays, which is exactly why aligning it would have moved three
   * other things).
   *
   * And where the two CAN still differ — a session whose `sdkCwd` was moved
   * after launch — the divergence is already disclosed rather than hidden: the
   * third argument is `session?.sdkCwd`, and `getWorkingDirectoryContext`'s
   * mismatch arm tells the model the bash shell runs elsewhere and to use
   * absolute paths. Nothing was changed for D1.141; this is the reading that
   * says why.
   *
   * ## F1.907 — Pi without a project is the one caller where that fallback is wrong
   *
   * Pi does not run in the session folder: its process and file tools run in
   * `session.workingDirectory ?? workspaceRootPath` (`PiAgent.resolvedCwd`), and
   * the session folder is managed storage its file floor refuses. So Pi asks
   * with `runtimeStatesWorkingDirectory` and gets the pathless
   * {@link PI_NO_PROJECT_WORKING_DIRECTORY_CONTEXT} instead, while Pi's own
   * `Current working directory:` line names the folder. A project-bound Pi
   * session, and every claude and codex call, keeps the block below unchanged.
   */
  getWorkingDirectoryContext(options: StableContextPartsOptions = {}): string | null {
    const sessionId = this.config.session?.id;
    const effectiveWorkingDir = this.config.session?.workingDirectory ??
      (sessionId ? getSessionDirPath(this.workspaceId, sessionId) : undefined);
    const isSessionRoot = !this.config.session?.workingDirectory && !!sessionId;
    if (options.runtimeStatesWorkingDirectory && isSessionRoot) return PI_NO_PROJECT_WORKING_DIRECTORY_CONTEXT;

    return getWorkingDirectoryContext(
      effectiveWorkingDir,
      isSessionRoot,
      this.config.session?.sdkCwd
    );
  }

  // ============================================================
  // Recovery Context
  // ============================================================
  //
  // THE RECOVERY BUILDER LIVES ON `BaseAgent`, and only there.
  //
  // This class carried a second `buildRecoveryContext(messages?)` that emitted a
  // byte-identical `<conversation_recovery>` block — the same element, the same
  // prose, the same per-message 1000-char cap — with the transcript composed
  // RAW. It had zero call sites: all five live `this.buildRecoveryContext()`
  // calls (`claude-agent.ts` ×4, `pi-agent.ts` ×1) resolve to
  // `BaseAgent.buildRecoveryContext`, which P2.18 fenced and defanged.
  //
  // A dead duplicate of a security-sensitive composer is worse than dead code:
  // `PromptBuilder` is exported (`agent/core/index.ts` → `agent/index.ts`), so
  // the next caller who reaches for the obvious name gets the UNFENCED copy and
  // silently reopens the hole P2.18 closed — a message body could end the
  // element early and speak in the host's voice on the turn that restores an
  // interrupted session. Deleted rather than fenced (P2.24): keeping it would
  // mean maintaining two composers of one block, which is how the two drift
  // apart again. `@nessy-agent/shared` is a workspace-only package — every
  // dependant is in this repo and none referenced the method — so removing it
  // from the exported type breaks no consumer.

  // ============================================================
  // User Preferences
  // ============================================================

  /**
   * Format user preferences for prompt injection.
   * Preferences are pinned on first call to ensure consistency within a session.
   *
   * @param forceRefresh - Force refresh of cached preferences
   * @returns Formatted preferences string
   */
  formatPreferences(forceRefresh = false): string {
    // Return pinned preferences if available (ensures session consistency)
    if (this.pinnedPreferencesPrompt && !forceRefresh) {
      return this.pinnedPreferencesPrompt;
    }

    // Load and format preferences (function loads internally)
    this.pinnedPreferencesPrompt = formatPreferencesForPrompt();
    return this.pinnedPreferencesPrompt;
  }

  /**
   * Clear pinned preferences (called on session clear).
   */
  clearPinnedPreferences(): void {
    this.pinnedPreferencesPrompt = null;
  }

  // ============================================================
  // Configuration Accessors
  // ============================================================

  /**
   * Update the workspace configuration.
   */
  setWorkspace(workspace: PromptBuilderConfig['workspace']): void {
    this.config.workspace = workspace;
    this.workspaceRootPath = workspace.workspaceRootPath;
    this.workspaceId = workspace.id;
  }

  /**
   * Update the session configuration.
   */
  setSession(session: PromptBuilderConfig['session']): void {
    this.config.session = session;
  }

  /** W8: project/prompt resources come from the captured capability snapshot. */
  setCapabilityRuntimeActive(active: boolean): void {
    this.capabilityRuntimeActive = active;
  }

  /** P3.238 — register the runtime name thunk. See {@link backendNameProvider}. */
  setBackendNameProvider(provider: () => string): void {
    this.backendNameProvider = provider;
  }

  /** P3.238 — the registered runtime name, or `undefined` when there is none to be had. */
  private resolveBackendName(): string | undefined {
    try {
      return this.backendNameProvider?.() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get the workspace root path.
   */
  getWorkspaceRootPath(): string {
    return this.workspaceRootPath;
  }

  /**
   * Check if debug mode is enabled.
   */
  isDebugMode(): boolean {
    return this.config.debugMode?.enabled ?? false;
  }

  /**
   * Get the system prompt preset.
   */
  getSystemPromptPreset(): string {
    return this.config.systemPromptPreset ?? 'default';
  }
}

/** Per-call options for {@link PromptBuilder.buildStableContextParts}. */
export interface StableContextPartsOptions {
  /**
   * F1.907 — the runtime names its own working directory in the prompt (Pi's
   * `Current working directory:` line), so a session with no project is not
   * told the session folder. Unset keeps every other caller byte-identical.
   */
  runtimeStatesWorkingDirectory?: boolean;
}

/**
 * F1.907 — the working-directory block for a Pi session with no project,
 * composed by {@link PromptBuilder.getWorkingDirectoryContext} when its caller
 * says the runtime states its own folder (`runtimeStatesWorkingDirectory`).
 *
 * Pathless on purpose. Pi runs such a session in the workspace root, and its
 * own prompt ends with `Current working directory: <cwd>`, the folder its tools
 * resolve against; the host replaces that prompt whole, so the subprocess
 * adapter re-appends the line from `event.systemPromptOptions.cwd`
 * (`withPiWorkingDirectoryLine` in `packages/pi-agent-server/src/compat/pi-runtime-adapter.ts`).
 * Naming the session folder here instead told the model a directory the file
 * floor refuses. Plans and attachments live apart from the working folder;
 * their exact paths already reach the model (`<session_state>`'s plans folder,
 * each attachment's stored path), so this names where to look, not a path.
 */
export const PI_NO_PROJECT_WORKING_DIRECTORY_CONTEXT = `<working_directory_context>
No project folder is selected for this session. Your file tools and shell run in the folder named on the "Current working directory:" line at the end of this prompt; resolve relative paths against it.
This session's plans and attachments are kept apart from that folder: write plans to the plans folder named in <session_state>, and read each attachment at the path it was stored at.
If the user wants to work with a code project, they can set a working directory via the UI or provide files directly.
</working_directory_context>`;

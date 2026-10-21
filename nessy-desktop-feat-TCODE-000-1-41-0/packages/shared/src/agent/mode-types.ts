/**
 * Mode Types and Constants
 *
 * Pure types and UI configuration for permission modes.
 * This file has NO runtime dependencies - safe for browser bundling.
 *
 * For runtime mode management functions, use './mode-manager.ts'
 */

import { z } from 'zod';

// ============================================================
// Permission Mode Types
// ============================================================

/**
 * Available permission modes (internal storage keys).
 *
 * The vocabulary is EXACTLY Claude's (`permission-modes.md` "Available modes")
 * — `default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`.
 * F1.1050 (owner, 2026-09-28) retired Nessy's own `explore`: a stored or sent
 * `explore` (and its older spelling `safe`) is read as `plan` forever and never
 * written. The pre-migration spellings (`ask`, `safe`, `allow-all`, and the
 * older `execute`/`ask-to-edit`) remain readable forever through
 * {@link parsePermissionMode}'s alias table; they are never written again.
 *
 * ONE VOCABULARY, THREE TRANSLATIONS (owner decision 2026-08-16). The user sees
 * this set on every runtime — a mode states user INTENT, which does not change
 * when the runtime under it does — and each runtime translates it in exactly one
 * place: Pi by identity (the gate, `core/pre-tool-use.ts`, takes the mode
 * verbatim), Claude through `CLAUDE_SDK_PERMISSION_MODE_TABLE`
 * (`claude-permission-mode.ts`), Codex through `CODEX_PERMISSION_MODE_TABLE`
 * (`codex-responses-adapter/src/config-writer.ts`). Adding a member means
 * adding a row to each of those, and
 * `__tests__/permission-mode-runtime-translations.test.ts` is what fails if one
 * is missed.
 */
export type PermissionMode = 'dontAsk' | 'plan' | 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';

/**
 * Canonical mode names used in user-facing/session-state surfaces.
 *
 * Since the vocabulary flip, internal keys ARE the canonical names — the type
 * and the two mappings below survive because the canonical channel is a real
 * seam (session-state surfaces, fixtures) even while the mapping is identity.
 */
export type PermissionModeCanonical = PermissionMode;

/**
 * Order of modes for cycling with SHIFT+TAB.
 *
 * This is also the canonical STRICTNESS ordering, from most restrictive to
 * least: `dontAsk < plan < default < acceptEdits < auto < bypassPermissions`
 * (F1.1050 dropped `explore` and kept the rest in place). A lower index is stricter (fewer automatic
 * permissions). Used by `clampPermissionModeToParent` to guarantee a child
 * session can only ever narrow, never broaden, its effective permissions
 * relative to the parent.
 *
 * THE POSITIONS ARE THE CLAMP'S INDEX — the vocabulary migration changed
 * SPELLING only, never position. A reordered entry here is a silent
 * permission widening with zero type errors.
 *
 * WHY `dontAsk` is index 0: the calls that can execute in it are the
 * rule-allowed set plus the built-in read-only allowlist, and nothing else — a
 * subset of `plan` (which additionally grants the plan file and the session data
 * folder) and of `default` (where a human can approve anything).
 * It is also the only position at which the clamp cannot widen: a `dontAsk`
 * parent must never resolve a child to a mode that is able to prompt.
 *
 * Note that being in this table does NOT put a mode in the SHIFT+TAB cycle —
 * that is `cyclablePermissionModes` in config-defaults.json, which enumerates
 * its modes explicitly.
 */
export const PERMISSION_MODE_ORDER: PermissionMode[] = ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];

/**
 * The SHIFT+TAB rotation when a workspace has not configured its own
 * `cyclablePermissionModes`.
 *
 * `dontAsk` is deliberately absent: cycling into a mode that silently denies and
 * never prompts would be a surprise mid-session. Every picker hides it too
 * (`PICKER_HIDDEN_MODES` in the renderer's composer-permission-modes) — it is
 * settable through config, the CLI flag, and automations only.
 *
 * `bypassPermissions` IS here, since D1.369 (owner, 2026-09-18: it must be
 * offered rather than hidden). permission-modes.md's "can only be set at
 * startup" is a CLI launch flag we do not have; the desktop's enable is the
 * first-activation responsibility dialog, which every entry point still passes
 * through. A workspace `cyclablePermissionModes` may still leave it out.
 */
export const DEFAULT_CYCLABLE_PERMISSION_MODES: PermissionMode[] =
  PERMISSION_MODE_ORDER.filter(mode => mode !== 'dontAsk');

/**
 * F8 — the highest permission mode a REMOTE client (a phone, a tablet — any
 * client that is not running on the machine) may set.
 *
 * Both incumbents restrict this: Claude's mobile app refuses Bypass outright.
 * The reasoning is not about trust in the user, it is about where the device
 * is: a phone in a pocket, on a network someone else runs, must not be able to
 * un-gate a workstation. `auto` stays reachable because it still asks about the
 * things that matter; `bypassPermissions` stops asking at all.
 *
 * Enforced on the SERVER (`sessions.ts` → `setPermissionMode`), not by hiding
 * it in a picker — a hidden control is a suggestion, and the client is the one
 * piece of this system an attacker can replace.
 */
export const REMOTE_CLIENT_PERMISSION_MODE_CEILING: PermissionMode = 'auto';

/** Whether a remote client may set this mode. */
export function isPermissionModeAllowedForRemoteClient(mode: PermissionMode): boolean {
  return (
    PERMISSION_MODE_ORDER.indexOf(mode) <=
    PERMISSION_MODE_ORDER.indexOf(REMOTE_CLIENT_PERMISSION_MODE_CEILING)
  );
}

/**
 * The interactive write modes — `default`, `acceptEdits`, `auto`: every tool
 * is admitted up front and the prompt/deny decision is deferred to the
 * pre-tool-use seam. `dontAsk` is deliberately NOT here (it has no later
 * prompt), and `plan` blocks writes outright. `bypassPermissions` is
 * not here either: it never reaches the prompt seam.
 *
 * Declared ONCE, next to PERMISSION_MODE_ORDER, because two production sites
 * gate on this set — `shouldAllowToolInMode` (mode-manager) and the
 * pre-tool-use prompt branch — and only the LAST of them produces a prompt.
 * Independent literal spellings meant a future mode-set change could
 * desynchronize them with zero type errors, and a call admitted by the first
 * that misses the second falls through to a silent allow.
 *
 * It said THREE sites until P6.578: the third, `PermissionManager.checkBashCommand`,
 * had zero product callers and was deleted rather than wired, because it
 * duplicated `shouldAllowToolInMode`'s own bash branch.
 */
export function isInteractiveWritePermissionMode(mode: PermissionMode): boolean {
  return mode === 'default' || mode === 'acceptEdits' || mode === 'auto';
}

/**
 * Clamp a child's requested permission mode so it is never broader than the
 * parent's. Returns the STRICTER of the two (the one with the lower index in
 * `PERMISSION_MODE_ORDER`). A broader request clamps down to the parent; a
 * stricter request is honored as-is. This is the single narrow-only rule that
 * keeps a spawned child from escalating permissions above its parent.
 *
 * F1.1050 (DN-272, 2026-09-29) — THERE IS NO SPECIAL CASE ANY MORE. Until the
 * retirement `explore` sat at index 1 below `plan` while being INCOMPARABLE with
 * it on the write axis (explore wrote the session's plans/data/additional
 * folders, plan wrote nothing), so `clamp(explore, plan)` returned the PARENT.
 * With `explore` gone every pair is a total order on the write axis and the
 * index compare alone decides. A stored `explore` reaches this function only
 * after {@link parsePermissionMode} has read it as `plan`, so a former
 * `explore` child of a `plan` parent resolves to `plan` — what the special case
 * returned. The codex duplicate (`clampCodexPermissionMode`) dropped its copy
 * in the same change, and the translations test compares all 36 pairs.
 *
 *
 * ## P6.496 — THIS RUNS NARROWER THAN THE PAGE, DELIBERATELY. DO NOT "FIX" IT.
 *
 * `agent-sdk/permissions.md#available-modes`, the Subagent-inheritance warning,
 * verbatim: *"Subagents inherit the parent session's permission mode. An
 * `AgentDefinition`'s `permissionMode` can override it, except when the parent
 * uses `bypassPermissions`, `acceptEdits`, or `auto`: those modes apply to every
 * subagent and can't be overridden per subagent."*
 *
 * So the documented rule DISCARDS the child's declared mode under those three
 * parents — including a declared mode that is STRICTER than the parent's. Ours
 * keeps it: a subagent declaring `plan` under a `bypassPermissions` parent runs
 * in `plan` here and would run in `bypassPermissions` upstream.
 *
 * The deviation is safe-direction and that is the whole reason it stands.
 * Matching the page would LOOSEN what a subagent may do — it would take a
 * definition that asked for less authority and hand it more, on the three
 * broadest parents there are, and the page's own next paragraph says why that
 * matters: *"Subagents may have different system prompts and less constrained
 * behavior than your main agent, so inheriting `bypassPermissions` grants them
 * full, autonomous system access."* Delegated decision 2026-09-05 (Q-den 5) took
 * option A — record it, pin it, document it — and refused option B (match the
 * page) for exactly that reason.
 *
 * It is ONE host mechanism shared by all three runtimes, so this is host-vs-page
 * rather than runtime-vs-runtime: there is no per-runtime divergence to close
 * and nothing native to enable. `packages/pi-agent-server/README.md`
 * (§`maxTurns` and `permissionMode` semantics) states it where a definition
 * author reads it, and
 * `agent/__tests__/permission-mode-clamp.test.ts` pins the three parents so the
 * next reader of that warning cannot quietly align us with it.
 */
export function clampPermissionModeToParent(requested: PermissionMode, parent: PermissionMode): PermissionMode {
  const requestedRank = PERMISSION_MODE_ORDER.indexOf(requested);
  const parentRank = PERMISSION_MODE_ORDER.indexOf(parent);
  // Unknown modes (defensive; -1) never widen: fall back to the parent.
  if (requestedRank < 0) return parent;
  if (parentRank < 0) return requested;
  // F1.1050: the `plan` parent / `explore` child special case left with
  // `explore` — every remaining pair is totally ordered (see the docblock).
  //
  return requestedRank <= parentRank ? requested : parent;
}

/** Replace a host-managed disabled mode with the nearest stricter one, never a broader one. */
export function normalizeManagedPermissionMode(
  requested: PermissionMode,
  disabledPermissionModes: readonly PermissionMode[],
): PermissionMode {
  if (!disabledPermissionModes.includes(requested)) return requested
  const fallbacks: Record<PermissionMode, readonly PermissionMode[]> = {
    bypassPermissions: ['auto', 'acceptEdits', 'default', 'plan'],
    auto: ['acceptEdits', 'default', 'plan'],
    acceptEdits: ['default', 'plan'],
    default: ['plan'],
    // F1.1050: `explore` had its own row here (it fell back to itself only).
    plan: ['plan'],
    // Same shape as plan: no broader fallback exists, so a disabled
    // `dontAsk` resolves to the `?? 'plan'` floor rather than to a mode that
    // could prompt.
    dontAsk: ['dontAsk'],
  }
  return fallbacks[requested].find(mode => !disabledPermissionModes.includes(mode)) ?? 'plan'
}

/**
 * Internal -> canonical mapping. Identity since the vocabulary flip; the seam
 * survives so canonical consumers keep one named crossing point.
 */
export const PERMISSION_MODE_TO_CANONICAL: Record<PermissionMode, PermissionModeCanonical> = {
  dontAsk: 'dontAsk',
  // F1.1050: no `explore` entry — the mode is retired (read as `plan`).
  plan: 'plan',
  default: 'default',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  bypassPermissions: 'bypassPermissions',
};

/**
 * Canonical -> internal mapping. Identity since the vocabulary flip.
 */
export const CANONICAL_TO_PERMISSION_MODE: Record<PermissionModeCanonical, PermissionMode> = {
  dontAsk: 'dontAsk',
  // F1.1050: no `explore` entry — the mode is retired (read as `plan`).
  plan: 'plan',
  default: 'default',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  bypassPermissions: 'bypassPermissions',
};

/**
 * Convert internal mode key to canonical user-facing mode name.
 */
export function toCanonicalPermissionMode(mode: PermissionMode): PermissionModeCanonical {
  return PERMISSION_MODE_TO_CANONICAL[mode];
}

/**
 * The ONE spelling table every mode read path consumes. Keys are the accepted
 * spellings after lowercasing and stripping `-`/`_`/space separators; values
 * are internal mode keys. Three vocabularies coexist here FOREVER:
 *
 * - internal spellings (`safe`, `ask`, `allow-all`, ...),
 * - Claude's vocabulary (`default`, `manual`, `bypassPermissions`, ...),
 * - legacy aliases (`execute`, `ask-to-edit`, `automatic`).
 *
 * Both parsers — {@link parsePermissionMode} here and
 * `mapClaudeModeToPermissionMode` in `pi-agent.ts` — resolve through this
 * table, so their accepted sets cannot drift apart. Persisted spellings come
 * back through five doors (session JSONL headers and their nested mode
 * fields, managed policy, agent frontmatter, automations), and every one of
 * them must alias-resolve through this table before any unknown-mode
 * fallback. Never REMOVE a key: a spelling that was ever written to disk must
 * stay readable.
 *
 * Null-prototype on purpose: a lookup like `table['constructor']` must miss,
 * not surface `Object.prototype` members.
 */
const PERMISSION_MODE_ALIASES: Readonly<Record<string, PermissionMode>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, PermissionMode>, {
    // Internal spellings (Claude's vocabulary).
    dontask: 'dontAsk',
    explore: 'plan', // F1.1050: the retired Nessy mode, read as plan FOREVER — never remove this key
    plan: 'plan',
    default: 'default',
    acceptedits: 'acceptEdits',
    auto: 'auto',
    bypasspermissions: 'bypassPermissions',
    // Claude's `manual` synonym for the manual (default) mode.
    manual: 'default',
    // Pre-migration internal spellings — persisted on disk forever.
    safe: 'plan', // explore's pre-migration spelling, so plan too (F1.1050)
    ask: 'default',
    allowall: 'bypassPermissions',
    // Legacy aliases.
    execute: 'bypassPermissions',
    asktoedit: 'default',
    automatic: 'auto',
    acceptsedits: 'acceptEdits',
  } satisfies Record<string, PermissionMode>),
);

/**
 * Parse user-facing mode names into internal mode keys.
 *
 * Accepts internal values, Claude's vocabulary (default/manual/acceptEdits/
 * auto/dontAsk/plan/bypassPermissions), and legacy aliases (explore and safe as
 * plan, execute, ask-to-edit, automatic), case- and separator-insensitively, via the shared
 * {@link PERMISSION_MODE_ALIASES} table. Returns null for anything else.
 */
export function parsePermissionMode(mode: string): PermissionMode | null {
  const normalized = mode.trim().toLowerCase().replace(/[-_ ]/g, '');
  return PERMISSION_MODE_ALIASES[normalized] ?? null;
}

// ============================================================
// Permissions Config Types (Browser-safe Zod schemas)
// ============================================================

/**
 * API endpoint rule - method + path pattern
 */
const ApiEndpointRuleSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  path: z.string().describe('Regex pattern for API path'),
  comment: z.string().optional(),
});

export type ApiEndpointRule = z.infer<typeof ApiEndpointRuleSchema>;

/**
 * Pattern with optional comment
 */
const PatternSchema = z.union([
  z.string(),
  z.object({
    pattern: z.string(),
    comment: z.string().optional(),
  }),
]);

const ToolPermissionRuleSchema = z.object({
  pattern: z.string(),
  action: z.enum(['allow', 'deny', 'ask']),
  comment: z.string().optional(),
});

export type ToolPermissionRule = z.infer<typeof ToolPermissionRuleSchema>;

/**
 * Command-specific block hint for clearer rejection messages from the read-only allowlist (Plan, Don't ask).
 */
const BlockedCommandHintSchema = z.object({
  /** Command name (normalized lowercase base command, e.g. "printf") */
  command: z.string(),
  /** Primary reason shown when command is blocked */
  reason: z.string(),
  /** Additional policy/risk context */
  context: z.string().optional(),
  /** Suggested alternatives or next actions */
  tryInstead: z.array(z.string()).optional(),
  /** Concrete example command */
  example: z.string().optional(),
  /** Apply this hint only when the command does NOT match this regex */
  whenNotMatching: z.string().optional(),
});

export type BlockedCommandHintRule = z.infer<typeof BlockedCommandHintSchema>;

/**
 * Permissions JSON configuration schema
 *
 * Note: Core write tools (Write, Edit, MultiEdit, NotebookEdit) are hardcoded in
 * SAFE_MODE_CONFIG and blocked by the read-only allowlist (Plan, Don't ask). The blockedTools field
 * allows users to block additional tools beyond these defaults; the merge is a
 * union, so a declared list can only ever add to the hardcoded four.
 */
export const PermissionsConfigSchema = z.object({
  /** Version date for migration (ISO format: "2026-02-07") */
  version: z.string().optional(),
  /** Bash command patterns to allow (regex strings) */
  allowedBashPatterns: z.array(PatternSchema).optional(),
  /** MCP tool patterns to allow (regex strings) */
  allowedMcpPatterns: z.array(PatternSchema).optional(),
  /** API endpoint rules - method + path pattern */
  allowedApiEndpoints: z.array(ApiEndpointRuleSchema).optional(),
  /** Retired with Explore mode (F1.1050): no mode reads it; kept so a stored file still parses (glob patterns) */
  allowedWritePaths: z.array(PatternSchema).optional(),
  /** File paths that must not be read or written in any permission mode (glob patterns) */
  deniedPaths: z.array(PatternSchema).optional(),
  /** Tool names that must not run in any permission mode (glob patterns) */
  deniedToolPatterns: z.array(PatternSchema).optional(),
  /** Tool names allowed to run when configured as an allowlist (glob patterns) */
  allowedTools: z.array(PatternSchema).optional(),
  /** Tool names blocked from running in any permission mode (glob patterns) */
  disallowedTools: z.array(PatternSchema).optional(),
  /** Per-tool override rules evaluated after deniedPaths and deniedToolPatterns */
  toolRules: z.array(ToolPermissionRuleSchema).optional(),
  /**
   * Additional tools to block in the read-only modes (extends the hardcoded
   * defaults). EXACT tool names, not globs — the runtime tests membership of a
   * Set, and that test is the LAST branch of `shouldAllowToolInMode`, so THREE
   * separate earlier returns make a name declared here inert, with no diagnostic
   * on any surface:
   * 1. `ALWAYS_ALLOWED_TOOLS` and its `__<name>`-suffixed MCP spellings.
   * 2. `browser_tool` in every spelling — a SECOND, independent cause, not a
   *    case of the first: `browser_tool` is deliberately NOT in
   *    `ALWAYS_ALLOWED_TOOLS`, but the `isBrowserToolNameOrAlias` branch decides
   *    on the browser COMMAND and returns before this list is reached.
   * 3. `Bash`, decided by the read-only command classifier.
   * For glob matching, or for a block that covers any of those three or the
   * write modes, use `deniedToolPatterns` / `disallowedTools`, which are checked
   * ahead of every mode decision. Measured 2026-08-23: `blockedTools:
   * ['WebFetch']` leaves WebFetch allowed in explore, plan AND default, while
   * `deniedToolPatterns: ['Web*']` blocks it in all three.
   */
  blockedTools: z.array(PatternSchema).optional(),
  /** Command-specific hint messages for blocked Bash commands */
  blockedCommandHints: z.array(BlockedCommandHintSchema).optional(),
  /** Versioned Nessy readable permission rules, compiled by the existing policy owner. */
  permissionDsl: z.unknown().optional(),
});

export type PermissionsConfigFile = z.infer<typeof PermissionsConfigSchema>;

// ============================================================
// Mode Config Types
// ============================================================

/** Compiled API endpoint rule for runtime checking ({@link apiEndpointRuleGrantsTool} says which API tool it reaches). */
export interface CompiledApiEndpointRule {
  method: string;
  pathPattern: RegExp;
  /** F1.1152 — set when the rule came from `sources/<slug>/permissions.json`: it then grants only that source's own API tool. */
  sourceSlug?: string;
}

/**
 * Compiled bash pattern with metadata for error messages.
 * Stores the original pattern string and comment alongside the compiled RegExp
 * so we can provide helpful error messages when commands don't match.
 */
export interface CompiledBashPattern {
  /** Compiled regex for matching */
  regex: RegExp;
  /** Original pattern string (for error messages) */
  source: string;
  /** Human-readable comment explaining what this pattern allows */
  comment?: string;
}

/**
 * Runtime command-specific hint for blocked Bash commands.
 */
export interface CompiledBlockedCommandHint {
  /** Base command token (lowercase), e.g. "printf" */
  command: string;
  reason: string;
  context?: string;
  tryInstead?: string[];
  example?: string;
  /** Optional condition: hint applies only when command does NOT match this regex */
  whenNotMatching?: string;
  whenNotMatchingRegex?: RegExp;
}

/**
 * Analysis of why a command didn't match a pattern.
 * Used by incr-regex-package to provide detailed diagnostics showing
 * exactly WHERE matching failed and what was expected.
 */
export interface MismatchAnalysis {
  /** How much of the command matched before failure */
  matchedPrefix: string;
  /** Character position where matching stopped */
  failedAtPosition: number;
  /** The token/word that caused the mismatch */
  failedToken: string;
  /** The pattern that got closest to matching */
  bestMatchPattern?: {
    source: string;
    comment?: string;
  };
  /** Actionable suggestion for the user/agent */
  suggestion?: string;
}

/**
 * Paths to permissions configuration files.
 * Used in error messages to guide the agent on how to customize permissions.
 */
export interface PermissionPaths {
  /** Path to workspace-level permissions.json */
  workspacePath: string;
  /** Path to app-level default.json */
  appDefaultPath: string;
  /** Path to permissions documentation */
  docsPath: string;
}

/**
 * Safe mode configuration - defines behavior for read-only mode
 */
export interface ModeConfig {
  /**
   * Tools blocked in safe mode. SAFE_MODE_CONFIG's four (Write, Edit, MultiEdit,
   * NotebookEdit) are the hardcoded floor and cannot be removed; a merged config
   * carries those plus every `blockedTools` name the layers declared.
   */
  blockedTools: Set<string>;
  /** Read-only Bash command patterns with metadata for helpful error messages */
  readOnlyBashPatterns: CompiledBashPattern[];
  /** Command-specific hints shown when blocked Bash commands are rejected */
  blockedCommandHints?: CompiledBlockedCommandHint[];
  /** Read-only MCP patterns (tools matching these are allowed) */
  readOnlyMcpPatterns: RegExp[];
  /** Fine-grained API endpoint rules (method + path pattern) */
  allowedApiEndpoints: CompiledApiEndpointRule[];
  /** Retired with Explore mode (F1.1050): merged, but no mode reads it (glob patterns) */
  allowedWritePaths?: string[];
  /** File paths that must not be read or written in any permission mode (glob patterns) */
  deniedPaths?: string[];
  /** Tool names that must not run in any permission mode (glob patterns) */
  deniedToolPatterns?: string[];
  /** Tool names allowed to run when configured as an allowlist (glob patterns) */
  allowedTools?: string[];
  /** Tool names blocked from running in any permission mode (glob patterns) */
  disallowedTools?: string[];
  /** Per-tool allow/deny/ask rules evaluated before the mode default decision */
  toolRules?: ToolPermissionRule[];
  /** User-friendly name */
  displayName: string;
  /** Keyboard shortcut hint */
  shortcutHint: string;
  /** Paths to permission files for actionable error messages */
  permissionPaths?: PermissionPaths;
}

// ============================================================
// Safe Mode Configuration (Browser-safe - pure data)
// ============================================================

/**
 * Minimal fallback configuration for safe mode.
 *
 * The actual patterns are loaded from ~/.nessy-agent/permissions/default.json
 * at runtime by PermissionsConfigCache. This fallback ensures the app works
 * even if the JSON file is missing or invalid.
 *
 * To customize allowed commands, edit ~/.nessy-agent/permissions/default.json
 */
export const SAFE_MODE_CONFIG: ModeConfig = {
  // Tools that are always blocked (no read-only variant) - these are hardcoded
  // as they represent fundamental write operations that should never be allowed
  // by the read-only allowlist (Plan, Don't ask) regardless of user configuration
  blockedTools: new Set([
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
  ]),
  // Empty fallbacks - actual patterns loaded from default.json
  // If default.json is missing, no bash commands will be auto-allowed in Plan or Don't ask
  readOnlyBashPatterns: [],
  blockedCommandHints: [],
  readOnlyMcpPatterns: [],
  allowedApiEndpoints: [],
  // The read-side credential floor, and the ONE list `getDeniedPathViolation`
  // consults for `Read`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Glob`/`Grep`
  // and for path tokens inside a `Bash` command. Kept byte-identical to the
  // `deniedPaths` array in `apps/electron/resources/permissions/default.json`,
  // which is the copy a real install reads; this one is the fallback for a
  // missing or corrupt file, so a pattern added to only one of the two protects
  // only half the installs.
  //
  // ## Where the entries come from
  //
  // The table under `agent-sdk/secure-deployment.md#read-only-code-mounting`,
  // headed "Even read-only access to a code directory can expose credentials.
  // Common files to exclude or sanitize before mounting", is the documented
  // enumeration and every row of it is covered here. Note how the page spells
  // them: `~/` on the tool-owned dotfiles and NO prefix on `.npmrc`, `.pypirc`,
  // `*-service-account.json`, `*.pem`, `*.key` — the unprefixed rows are the
  // ones that turn up INSIDE a repository, so anchoring them at `~` would
  // protect the copy nobody checks in and leave the copy that gets mounted.
  // That is what `~/.npmrc` did here until 2026-08-28 (measured: a project
  // `.npmrc` holding a registry `_authToken` was readable).
  //
  // `~/.config/git/credentials` is not on the page; it is the second location
  // git-credential-store(1) names for the same file (`$XDG_CONFIG_HOME/git/
  // credentials`), and `session-tools-core`'s `credentialDenyRoots` already
  // denies both. Denying only `~/.git-credentials` leaves a readable copy of
  // the same token, which is the bypass rather than a gap.
  //
  // ## This list is NOT `credentialDenyRoots`, and the gap between them is real
  //
  // `session-tools-core/src/runtime/credential-deny-roots.ts` denies a much
  // wider set (`~/.nessy`, `~/.config/gh`, `~/Library/Keychains`, browser cookie
  // stores, the whole of `~/.docker`), but that list is enforced by the OS
  // isolation profile, and isolation is OFF by default by standing owner
  // decision (2026-08-12/13). So in a default install THIS array is the only
  // read-side credential protection there is. Widening it toward
  // `credentialDenyRoots` is tracked separately; do not assume the two agree.
  //
  // ## THIS FLOOR IS EVIDENCED ON DARWIN ONLY (P3.129, owner ruling 2026-09-01)
  //
  // Every probe of these entries — unit, contract and live — has run on darwin.
  // No Windows run has ever executed, on any runtime (P3.62 records the same
  // for codex: darwin-arm64 only). The owner DEFERRED a real Windows exercise
  // until a Windows build ships and asked that the deferral be recorded as a
  // posture, because unstated ignorance reads as "we checked".
  //
  // The trap that makes it worth a paragraph rather than a line: ON DARWIN THE
  // BROKEN PATH IS THE IDENTITY FUNCTION. Two shipped security defects were
  // invisible for exactly that reason — a directory deny that never matched its
  // own directory (P3.104), and ten of these entries inert under a Windows home
  // (P3.108). A green suite cannot see either, and neither can the live
  // checklist: it has no Windows case and its driver runs on darwin.
  //
  // The probe is already designed, in `__tests__/credential-read-floor.test.ts`
  // beside the assertions it would extend: on a real Windows build, reach
  // `~/.ssh` and `~/.aws` through `Read`, `Grep` AND `Glob` and confirm all
  // three refuse, with an open neighbour as the negative control.
  deniedPaths: [
    '**/.env',
    '**/.env.*',
    '~/.ssh/**',
    '~/.gnupg/**',
    '~/.aws/**',
    '~/.config/gcloud/**',
    '~/.azure/**',
    '~/.kube/**',
    '~/.docker/config.json',
    '~/.git-credentials',
    '~/.config/git/credentials',
    // The forge CLIs' own token stores (P6.197). `~/.config/gh` was already in
    // `credentialDenyRoots` and NOT here, which is the gap that list's docblock
    // warns about two paragraphs up; `glab-cli` was in neither.
    //
    // Read from the SOURCE rather than a page (owner rule 2026-08-28), because
    // both CLIs resolve their directory through a precedence chain a page
    // summarises loosely. `cli/go-gh/pkg/config/config.go` — "Config path
    // precedence: GH_CONFIG_DIR, XDG_CONFIG_HOME, AppData (windows only), HOME"
    // — writes `hosts.yml` (the token) beside `config.yml`.
    // `gitlab-org/cli/internal/config/config_file.go` names four, in order:
    // `$GLAB_CONFIG_DIR/config.yml`, `~/.config/glab-cli/config.yml` (legacy),
    // `$XDG_CONFIG_HOME/glab-cli/config.yml`, `$XDG_CONFIG_DIRS/…`; the file
    // holds `token` and `oauth2_refresh_token` unless `use_keyring` moves them.
    '~/.config/gh/**',
    '~/.config/glab-cli/**',
    // THE ONE THAT IS NOT A DOTFILE IN `$HOME`, and the reason this row is not
    // just two entries: `internal/config/local_config.go` — `LocalConfigDir()`
    // returns `append(GitDir(true), "glab-cli")` — so glab ALSO reads
    // `<git dir>/glab-cli/config.yml`, a credential store INSIDE the workspace
    // the model is already reading. A `~`-anchored pattern cannot reach it, the
    // same asymmetry `**/.npmrc` was corrected for on 2026-08-28.
    '**/.git/glab-cli/**',
    // RESIDUE, stated rather than papered over: `$GH_CONFIG_DIR`,
    // `$GLAB_CONFIG_DIR`, a relocated `$XDG_CONFIG_HOME` and `$XDG_CONFIG_DIRS`
    // are unreachable from a `~`-anchored glob, so a host that relocates either
    // CLI's config keeps a readable token. That is the same class as the
    // Windows-home gap recorded above (P3.108) and is not closed here.
    // OUR OWN two credential locations (P6.674). The paragraph above says this
    // array is not `credentialDenyRoots` and that the gap between them is real —
    // and it was widest exactly here, on the host's own secrets. Measured
    // 2026-09-07: `~/.aws/credentials` was REFUSED and `~/.nessy/dp_auth_creds.json`
    // was ALLOWED in the same run, while the sandbox floor denies the second and
    // isolation is off by default, so nothing covered it at all.
    //
    // `~/.nessy` is NOT the app's config dir — it is shared with nessy-cli
    // (AGENTS.md § Gateway Facts) and holds the gateway JWT. The WHOLE directory
    // rather than the one filename, for the reason `credentialDenyRoots` already
    // wrote down and measured: something outside our control keeps
    // `dp_auth_creds.json.bak` and `.bak2` copies of the same token beside it —
    // both are on this machine right now — so denying one name leaves readable
    // copies, and rotated backup names are not ours to predict. `oauth_creds.json`
    // sits in the same directory.
    //
    // RELOCATION (DA1.5): this glob is `~`-anchored, and the directory is no
    // longer pinned to `~` — `packages/shared/src/auth/dp/creds-store.ts` symbol
    // `getNessyDir` honours nessy-cli's own `NESSY_HOME`. The relocated
    // directory is covered by `relocatedCredentialDenyRoots`
    // (`packages/shared/src/agent/mode-manager.ts`), the same companion this
    // array's own residue paragraph above names for `$GH_CONFIG_DIR` and its
    // siblings; this entry stays exactly as it is, because the floors ADD the
    // relocated root and never substitute it for the default one.
    '~/.nessy/**',
    // The app's own encrypted store (`credentials/backends/secure-storage.ts`).
    // UNPREFIXED on purpose, which is the same asymmetry `**/.npmrc` was
    // corrected for: the config directory is relocatable through
    // `NESSY_CONFIG_DIR`, so a `~`-anchored entry protects the default install
    // and leaves every relocated one open. `credentialDenyRoots` takes the
    // config dir as a parameter and therefore does not have this problem; a
    // static glob has to solve it by not anchoring.
    //
    // Note the FILENAME: it is `credentials.enc`, not `credentials.json`. The
    // row that produced this entry named the latter, and no such file exists in
    // the config dir on any install — a probe path, not a product path.
    '**/credentials.enc',
    '**/.npmrc',
    '**/.pypirc',
    '~/.netrc',
    '**/*-service-account.json',
    '**/*.pem',
    '**/*.key',
    '**/id_rsa',
    '**/id_ed25519',
    // UA1.16 — the host's t-artifacts registry (`artifacts/registry.ts`
    // `ARTIFACT_REGISTRY_DENIED_PATH_PATTERN`): only the host writes it, no agent
    // reads or edits it. Unanchored like `credentials.enc` (the config dir moves),
    // narrowed by `workspaces/<id>` so a project's own `artifacts/registry.json` stays readable.
    '**/workspaces/*/artifacts/registry.json',
  ],
  deniedToolPatterns: [],
  allowedTools: [],
  disallowedTools: [],
  toolRules: [],
  displayName: 'Plan', // F1.1170: a fallback only, for a mode outside PERMISSION_MODE_AGENT_LABELS (none); Explore is retired
  shortcutHint: 'SHIFT+TAB',
};

/**
 * English mode names for the AGENT-FACING channel: system prompts, mode-switch
 * notices, tool block reasons, and protocol errors. This text goes to the
 * model and into logs, deliberately locale-independent — it is NOT a UI text
 * source. Renderer chrome (composer, menus, settings, playground) reads the
 * i18n `mode.*` keys instead, and `mode-label-source.test.ts` pins these
 * spellings byte-equal to the `en` locale's labels so the two channels cannot
 * drift apart.
 */
export const PERMISSION_MODE_AGENT_LABELS: Record<PermissionMode, string> = {
  'dontAsk': "Don't ask", // F1.1052: Claude's own name (permission-modes.md: `⏵⏵ don't ask on`), never "Unattended"
  'plan': 'Plan',
  'default': 'Manual',
  'acceptEdits': 'Accept edits',
  'auto': 'Auto',
  'bypassPermissions': 'Bypass permissions',
};

/**
 * Display configuration for each mode: structure only (icon path and theme
 * classes). Text does NOT live here — UI labels and descriptions come from
 * the i18n `mode.*` keys, agent-facing English from
 * {@link PERMISSION_MODE_AGENT_LABELS}. This config once carried
 * displayName/shortName/description copies of the same seven labels, and the
 * playground rendered those instead of the words the composer shows.
 */
export const PERMISSION_MODE_CONFIG: Record<PermissionMode, {
  /** SVG path data for the icon (viewBox 0 0 24 24, stroke-based) */
  svgPath: string;
  /** Tailwind color classes for consistent theming */
  colorClass: {
    /** Text color class (e.g., 'text-info') */
    text: string;
    /** Background color class (e.g., 'bg-info') */
    bg: string;
    /** Border color class (e.g., 'border-info') */
    border: string;
  };
}> = {
  'dontAsk': {
    // Bell-off icon from Lucide
    svgPath: 'M8.7 3A6 6 0 0 1 18 8v3c0 1.6.6 3 1.6 4.2 M17 17H4a2 2 0 0 0 1.6-3.2A6 6 0 0 0 6 11V8 M10.3 21a1.94 1.94 0 0 0 3.4 0 M2 2l20 20',
    colorClass: {
      text: 'text-foreground/60',
      bg: 'bg-foreground/60',
      border: 'border-foreground/60',
    },
  },
  'plan': {
    // Clipboard icon from Lucide
    svgPath: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M9 2h6v4H9z M9 12h6 M9 16h6',
    colorClass: {
      text: 'text-accent',
      bg: 'bg-accent',
      border: 'border-accent',
    },
  },
  'default': {
    // Info icon from Lucide
    svgPath: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4m0 4h.01',
    colorClass: {
      text: 'text-info',
      bg: 'bg-info',
      border: 'border-info',
    },
  },
  'acceptEdits': {
    // Check circle icon from Lucide
    svgPath: 'M9 12l2 2 4-4 M22 12a10 10 0 1 1-2.93-7.07',
    colorClass: {
      text: 'text-success',
      bg: 'bg-success',
      border: 'border-success',
    },
  },
  'auto': {
    // Zap icon from Lucide
    svgPath: 'M13 2 3 14h8l-1 8 10-12h-8l1-8z',
    colorClass: {
      text: 'text-info',
      bg: 'bg-info',
      border: 'border-info',
    },
  },
  'bypassPermissions': {
    // Repeat icon from Lucide (loop)
    svgPath: 'm17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
    colorClass: {
      text: 'text-accent',
      bg: 'bg-accent',
      border: 'border-accent',
    },
  },
};

/**
 * F1.1152 (origin DN-231) — does a compiled `allowedApiEndpoints` rule reach this
 * API tool? A rule from a WORKSPACE or global file reaches every API tool, as it
 * always did. A rule from a source's own `sources/<slug>/permissions.json`
 * reaches only that source's tool, `api_<slug>` (`buildApiConfig` names the
 * config after the slug, `createApiTool` names the tool `api_<config.name>`):
 * bare, or as the last segment behind any MCP server prefix
 * (`mcp__<server>__api_<slug>`, codex's `mcp__sources__<wire>__api_<slug>`).
 * Measured before: source A's file allowed a POST on source B's API tool with no
 * card in every non-bypass mode — the scoping F1.287 gave a source's
 * `allowedMcpPatterns` and F1.715 its other grants. With no tool named, a
 * source's rule grants nothing.
 */
export function apiEndpointRuleGrantsTool(rule: CompiledApiEndpointRule, toolName: string | undefined): boolean {
  if (rule.sourceSlug === undefined) return true;
  return toolName !== undefined && toolName.split('__').pop() === `api_${rule.sourceSlug}`;
}

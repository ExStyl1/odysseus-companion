/**
 * Safe Mode Configuration
 *
 * Allows customization of Safe Mode rules per workspace and per source.
 * Users can create permissions.json files to extend the default rules.
 *
 * File locations:
 * - Workspace: CONFIG_DIR/workspaces/{slug}/permissions.json
 * - Per-source: CONFIG_DIR/workspaces/{slug}/sources/{sourceSlug}/permissions.json
 *
 * Rules are additive - custom configs extend the defaults (more permissive).
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync, appendFileSync } from 'fs';
import { createHash } from 'node:crypto';
import { join } from 'path';
import { debug } from '../utils/debug.ts';
import { safeJsonParse } from '../utils/files.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import { getBundledAssetsDir } from '../utils/paths.ts';
import { getSourcePath } from '../sources/storage.ts';
import { isValidPermissionsFile } from '../config/validators.ts';
import {
  SAFE_MODE_CONFIG,
  PermissionsConfigSchema,
  type ApiEndpointRule,
  type PermissionsConfigFile,
  type CompiledApiEndpointRule, apiEndpointRuleGrantsTool,
  type CompiledBashPattern,
  type CompiledBlockedCommandHint,
  type BlockedCommandHintRule,
  type PermissionPaths,
  type ToolPermissionRule,
} from './mode-types.ts';
import {
  compilePermissionDslV1,
  NESSY_PERMISSION_DSL_VERSION,
  parsePermissionDslSourceV1,
  parsePermissionJsonc,
  type CompiledPermissionDslV1,
  type PermissionDslDiagnosticV1,
  type PermissionDslLayerInputV1,
  type PermissionDslRuleV1,
  type PermissionDslScope,
  type PermissionDslSourceV1,
  type PermissionDslV1,
} from './pi-harness/permission-dsl.ts';
import {
  partitionSourceSlugs,
  type SourceSlugRejectionReason,
} from '../protocol/source-slugs.ts';
import { parseClaudeRuleString, type ClaudeRuleAction } from './pi-harness/claude-permission-rules.ts';
import { PERMISSION_RULE_TOOL_NAMES } from './pi-harness/harness-tool-descriptor.ts';
import { canonicalizeForDecision } from './session-filesystem-scope.ts';

// ============================================================
// App-level Permissions Directory
// ============================================================

// Track if permissions have been initialized this session (prevents re-init on hot reload)
let permissionsInitialized = false;

/**
 * Get the app-level permissions directory.
 * Default permissions are stored at CONFIG_DIR/permissions/.
 */
export function getAppPermissionsDir(): string {
  return join(CONFIG_DIR, 'permissions');
}

/**
 * Sync bundled default permissions to disk on launch.
 * Handles migrations when bundled version is newer:
 * - If file doesn't exist → copy from bundle
 * - If file exists but is invalid/corrupt → copy from bundle (auto-heal)
 * - If file exists and bundled is newer → retire superseded shipped strings, merge new patterns, update version
 * - If file exists and same/older version → no-op (preserve user changes)
 *
 * User customizations in workspace/source permissions.json files
 * are never touched by this function.
 */
export function ensureDefaultPermissions(): void {
  // Skip if already initialized this session (prevents re-init on hot reload)
  if (permissionsInitialized) {
    return;
  }
  permissionsInitialized = true;

  const permissionsDir = getAppPermissionsDir();

  // Create permissions directory if it doesn't exist
  if (!existsSync(permissionsDir)) {
    mkdirSync(permissionsDir, { recursive: true });
  }

  // Resolve bundled permissions directory via shared asset resolver
  const bundledPermissionsDir = getBundledAssetsDir('permissions');
  if (!bundledPermissionsDir) {
    return;
  }

  const destPath = join(permissionsDir, 'default.json');
  const srcPath = join(bundledPermissionsDir, 'default.json');

  if (!existsSync(srcPath)) {
    return;
  }

  // New install or corrupt file - copy fresh from bundle
  if (!existsSync(destPath) || !isValidPermissionsFile(destPath)) {
    try {
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(destPath, content, 'utf-8');
      debug('[Permissions] Installed default.json');
    } catch (error) {
      debug('[Permissions] Error installing default.json:', error);
    }
    return;
  }

  // Check if migration needed (bundled version > installed version)
  try {
    const installedContent = readFileSync(destPath, 'utf-8');
    const bundledContent = readFileSync(srcPath, 'utf-8');

    const installed = safeJsonParse(installedContent) as PermissionsConfigFile;
    const bundled = safeJsonParse(bundledContent) as PermissionsConfigFile;

    const installedVersion = installed.version || '2000-01-01';
    const bundledVersion = bundled.version || '2000-01-01';

    if (bundledVersion > installedVersion) {
      const merged = migratePermissions(retireShippedPatterns(installed, installedVersion, bundledVersion), bundled);
      writeFileSync(destPath, JSON.stringify(merged, null, 2), 'utf-8');
      debug('[Permissions] Migrated from', installedVersion, 'to', bundledVersion);
    } else {
      debug('[Permissions] Already up to date:', installedVersion);
    }
  } catch (error) {
    debug('[Permissions] Migration error:', error);
  }
}

/**
 * Merge new patterns from bundled config into existing installed config.
 * Preserves user customizations, adds new patterns, updates version.
 */
function migratePermissions(
  installed: PermissionsConfigFile,
  bundled: PermissionsConfigFile
): PermissionsConfigFile {
  // Get existing pattern strings for deduplication
  const getPatternString = (p: string | { pattern: string }): string =>
    typeof p === 'string' ? p : p.pattern;

  const existingBashPatterns = new Set(
    (installed.allowedBashPatterns || []).map(getPatternString)
  );
  const existingMcpPatterns = new Set(
    (installed.allowedMcpPatterns || []).map(getPatternString)
  );
  const existingDeniedPaths = new Set(
    (installed.deniedPaths || []).map(getPatternString)
  );
  const existingDeniedToolPatterns = new Set(
    (installed.deniedToolPatterns || []).map(getPatternString)
  );

  // Find new patterns not already in installed
  const newBashPatterns = (bundled.allowedBashPatterns || []).filter(
    p => !existingBashPatterns.has(getPatternString(p))
  );
  const newMcpPatterns = (bundled.allowedMcpPatterns || []).filter(
    p => !existingMcpPatterns.has(getPatternString(p))
  );
  const newDeniedPaths = (bundled.deniedPaths || []).filter(
    p => !existingDeniedPaths.has(getPatternString(p))
  );
  const newDeniedToolPatterns = (bundled.deniedToolPatterns || []).filter(
    p => !existingDeniedToolPatterns.has(getPatternString(p))
  );

  // Merge blocked command hints (dedupe by command + whenNotMatching + reason)
  const installedHints = installed.blockedCommandHints || [];
  const installedHintKeys = new Set(
    installedHints.map(h => `${h.command}::${h.whenNotMatching || ''}::${h.reason}`)
  );
  const newBlockedCommandHints = (bundled.blockedCommandHints || []).filter(
    h => !installedHintKeys.has(`${h.command}::${h.whenNotMatching || ''}::${h.reason}`)
  );

  debug('[Permissions] Adding', newBashPatterns.length, 'new bash patterns');
  debug('[Permissions] Adding', newMcpPatterns.length, 'new MCP patterns');
  debug('[Permissions] Adding', newDeniedPaths.length, 'new denied paths');
  debug('[Permissions] Adding', newDeniedToolPatterns.length, 'new denied tool patterns');
  debug('[Permissions] Adding', newBlockedCommandHints.length, 'new blocked command hints');

  return {
    ...installed,
    version: bundled.version,
    allowedBashPatterns: [
      ...(installed.allowedBashPatterns || []),
      ...newBashPatterns,
    ],
    allowedMcpPatterns: [
      ...(installed.allowedMcpPatterns || []),
      ...newMcpPatterns,
    ],
    deniedPaths: [
      ...(installed.deniedPaths || []),
      ...newDeniedPaths,
    ],
    deniedToolPatterns: [
      ...(installed.deniedToolPatterns || []),
      ...newDeniedToolPatterns,
    ],
    blockedCommandHints: [
      ...installedHints,
      ...newBlockedCommandHints,
    ],
  };
}

/**
 * Load default permissions from ~/.nessy-agent/permissions/default.json
 * Returns null if file doesn't exist or is invalid.
 */
export function loadDefaultPermissions(): PermissionsCustomConfig | null {
  const defaultPath = join(getAppPermissionsDir(), 'default.json');
  if (!existsSync(defaultPath)) {
    debug('[Permissions] No default.json found at', defaultPath);
    return null;
  }

  try {
    const content = readFileSync(defaultPath, 'utf-8');
    const config = parsePermissionsJson(content, getAppPermissionsDir());
    debug('[Permissions] Loaded default permissions from', defaultPath);
    return config;
  } catch (error) {
    debug('[Permissions] Error loading default permissions:', error);
    return null;
  }
}

// Re-export types from mode-types for external consumers
export {
  PermissionsConfigSchema,
  type ApiEndpointRule,
  type PermissionsConfigFile,
  type CompiledApiEndpointRule,
  type CompiledBashPattern,
  type PermissionPaths,
};

// ============================================================
// Types
// ============================================================

/**
 * Pattern entry with optional comment for error messages.
 * Preserves the comment from permissions.json so we can show helpful hints.
 */
export interface PatternWithComment {
  pattern: string;
  comment?: string;
}

/**
 * Parsed and normalized permissions configuration
 *
 * Note: the FOUR hardcoded blocked tools (Write, Edit, MultiEdit, NotebookEdit)
 * come from SAFE_MODE_CONFIG and cannot be removed here - they are fundamental
 * write operations blocked by the read-only allowlist (Plan, Don't ask). A config's own
 * `blockedTools` EXTENDS that set, per the schema's own word; see
 * {@link PermissionsCustomConfig.blockedTools}.
 */
export interface PermissionsCustomConfig {
  /** Additional bash patterns to allow (with optional comments for error messages) */
  allowedBashPatterns: PatternWithComment[];
  /** Additional MCP patterns to allow (as regex strings) */
  allowedMcpPatterns: string[];
  /** API endpoint rules for fine-grained control */
  allowedApiEndpoints: ApiEndpointRule[];
  /** UB7.6 / OQ-43.7 (a) — read by the DEFAULT (Ask) mode only (a write inside a glob runs card-free); NEVER in plan (F1.1050's plan absorption stands). Glob pattern strings. */
  allowedWritePaths: string[];
  /** File paths that must not be read or written in any permission mode */
  deniedPaths: string[];
  /** Tool names that must not run in any permission mode */
  deniedToolPatterns: string[];
  /** Tool allowlist patterns; when non-empty, tools outside the list are blocked */
  allowedTools: string[];
  /** Tool denylist patterns */
  disallowedTools: string[];
  /** Per-tool allow/deny/ask rules */
  toolRules: ToolPermissionRule[];
  /**
   * Extra tool names blocked in the read-only modes, added to the hardcoded
   * four. EXACT names, not globs: the only consumer is a `Set.has(toolName)`
   * membership test. `deniedToolPatterns`/`disallowedTools` are the glob levers,
   * and they apply in every mode rather than only the read-only ones.
   */
  blockedTools: string[];
  /** Command-specific hints for blocked Bash commands */
  blockedCommandHints: BlockedCommandHintRule[];
  /** Parsed readable-policy document or a safe fail-closed diagnostic. */
  permissionDsl?: PermissionDslSourceV1;
  /**
   * D3 — the directory this config was read from, threaded onto the compiled
   * layer so a `/`-anchored path rule resolves against its own settings source.
   * Set by `parsePermissionsJson`'s second argument and by nothing else, so the
   * KEEP decision and the ANCHOR can never disagree.
   */
  sourceRoot?: string;
  /**
   * P6.676 — the ALLOW-only inert forms this document carried, by code.
   *
   * A rule that parses to `{ warning }` with no `rule` never installs, so the
   * compiler never sees it and it can never appear in
   * `CompiledPermissionDslV1.diagnostics` — which is why the user-visible
   * reader, fed only by {@link reportPermissionDslDiagnostics}, could not
   * mention it however wide its type was. The codes ride out here instead, and
   * `buildMergedConfig` joins them to the SCOPE the layer came from, the same
   * join the compile-time half does.
   *
   * Codes only, never the message — the message interpolates the rule string
   * the user wrote, and `PermissionPolicyDiagnosticV1` is path-free BY TYPE.
   */
  inertPermissionRuleCodes?: readonly InertPermissionRuleCode[];
}

/**
 * The ALLOW-only inert forms — P6.676.
 *
 * Both are rules a user WROTE and that can never match, and both were told to
 * nobody: `parseClaudeRuleString` returns them as `{ warning }` with no rule,
 * so `claudeSettingsPermissionDsl`'s `!parsed.rule` branch used to drop them on
 * a `debug()` line that did not even name the code, and the one channel that
 * reaches a user without a debug flag is typed to the compiler's own codes.
 *
 * They are ALLOW-only by construction — `permissions.md` gives parameter rules
 * to deny and ask only, and gives an allow rule's tool-name glob a literal
 * glob-free prefix — so neither can ever describe a rule that was going to
 * restrict something. A silently inert GRANT is the dangerous direction: the
 * user believes an approval is pre-granted and every turn prompts instead.
 */
export const INERT_PERMISSION_RULE_CODES = [
  'claude_rule.param_allow_inert',
  'claude_rule.unanchored_allow_glob',
] as const;

export type InertPermissionRuleCode = typeof INERT_PERMISSION_RULE_CODES[number];

/** Narrow a parser warning's free-form code to the two this reader carries. */
function isInertPermissionRuleCode(code: string): code is InertPermissionRuleCode {
  return (INERT_PERMISSION_RULE_CODES as readonly string[]).includes(code);
}

/**
 * Merged permissions config for runtime use
 */
export interface MergedPermissionsConfig {
  /**
   * Tools blocked in the read-only modes: the hardcoded four (Write, Edit,
   * MultiEdit, NotebookEdit) UNION every `blockedTools` name the layers declare.
   * The union direction is the whole contract - a layer can add to this set and
   * can never take the four out of it.
   */
  blockedTools: Set<string>;
  /** Read-only bash patterns with metadata for helpful error messages */
  readOnlyBashPatterns: CompiledBashPattern[];
  /** Command-specific hints for blocked Bash command explanations */
  blockedCommandHints: CompiledBlockedCommandHint[];
  readOnlyMcpPatterns: RegExp[];
  /** Fine-grained API endpoint rules */
  allowedApiEndpoints: CompiledApiEndpointRule[];
  /** UB7.6 / OQ-43.7 (a) — merged; read by the DEFAULT (Ask) mode only (card-free inside a glob); NEVER in plan (glob patterns) */
  allowedWritePaths: string[];
  /** File paths that must not be read or written in any permission mode */
  deniedPaths: string[];
  /** Tool names that must not run in any permission mode */
  deniedToolPatterns: string[];
  /** Tool allowlist patterns; when non-empty, tools outside the list are blocked */
  allowedTools: string[];
  /** Tool denylist patterns */
  disallowedTools: string[];
  /** Per-tool allow/deny/ask rules */
  toolRules: ToolPermissionRule[];
  /** Display name for error messages */
  displayName: string;
  /** Keyboard shortcut hint */
  shortcutHint: string;
  /** Paths to permission files for actionable error messages */
  permissionPaths?: PermissionPaths;
  /** Existing policy owner's compiled readable rules. */
  permissionDsl?: CompiledPermissionDslV1;
  /**
   * P2.276 — the compiler's "skipped with a warning" half, in a shape a HOST can
   * put in front of a user.
   *
   * `managed-settings.md#keys-that-fail-closed`: "an individual entry that
   * fails, such as a malformed permission rule, is skipped with a warning while
   * the rest of the file applies." P2.270 shipped the skipping; P2.271 routed
   * the warning to `debug()`, which reaches stderr and `main.log` **only with
   * debug logging enabled** — so the ordinary user whose project settings
   * silently lose a rule still got nothing.
   *
   * ## Why this is not a second copy of `permissionDsl.diagnostics`
   *
   * The compiled program carries the diagnostics; it does NOT carry which SCOPE
   * each one came from, and the scope is what points at the file to edit. That
   * join is `reportPermissionDslDiagnostics`'s, keyed on diagnostic IDENTITY
   * (the compiler pushes the same object into `diagnostics` and into
   * `droppedRules[].diagnostic`). Re-deriving it at every consumer is how a
   * second reader ends up naming a different file than the log line does — so
   * the join happens once, here, and both readers take its result.
   *
   * ## Why only these two fields cross
   *
   * `severity` and `code` mirror `PiHarnessProjectConfigDiagnosticV1`, whose
   * comment states the rule: "code only, never the raw message/paths". That
   * rule binds harder here than the row that requested this field assumed. The
   * row's safety argument was that the rule id (`claude-settings-deny-0`) is
   * synthetic and path-free — TRUE for the ids `claudeSettingsPermissionDsl`
   * mints, and FALSE in general: a `permissionDsl` block in a workspace or
   * plugin `permissions.json` carries author-written ids, and the diagnostic
   * `message` interpolates both that id and the compiler's own reason, which
   * can quote the rule's pattern. So neither the id nor the message crosses.
   * `code` and `scope` are closed unions, path-free BY TYPE rather than by
   * inspection, and together they say "a rule in your project settings was
   * dropped because it would not compile" — which is what a user needs to go
   * and look.
   */
  permissionDslDiagnostics?: readonly PermissionPolicyDiagnosticV1[];
  /**
   * P2.203 — one entry per slug of `context.activeSourceSlugs` this merge
   * REFUSED to visit, saying why. Absent when the list was clean.
   *
   * See `protocol/source-slugs.ts` for the rule and for what was measured
   * without it. A closed union and nothing else — path-free BY TYPE, the same
   * discipline {@link permissionDslDiagnostics} keeps, because a refused slug is
   * externally authored and may itself BE a path. The raw value goes to
   * `debug()` beside the drop, nowhere else.
   *
   * ## Why not the POSITION as well
   *
   * `partitionSourceSlugs` does report an index, and it is an index into the
   * array it was handed — which here is the SORTED copy `getMergedConfig` mints,
   * not the caller's declared list. Carrying it would hand a future reader a
   * number that points at the wrong entry of the array it actually holds.
   * Measured, not reasoned: the first version of the test asserted declared
   * positions and got sorted ones. Count and reason are what survive the sort.
   *
   * ## This carrier's reader is not here yet, and that is stated rather than left
   *
   * The only channel in this codebase that puts a permissions warning in front
   * of a user is `SessionManager.announcePermissionPolicyDiagnostics`, which
   * reads {@link permissionDslDiagnostics} and sends an `info`/`warning` event.
   * That file is held by another lane this wave and is outside P2.203's zone, so
   * the hop is dispatched rather than done. Deliberately NOT folded into
   * {@link permissionDslDiagnostics} to borrow its reader: that event says a
   * rule "could not be compiled", and a refused slug is not a rule — the user
   * would be sent to fix something that does not exist, which is a worse answer
   * than the silence.
   *
   * Until that reader lands, the operator sees the drop on the debug line and
   * the user sees nothing. `@nessy-agent/shared` has no always-on log channel
   * (`debug()` is `NESSY_DEBUG=1`, and a packaged build logs nothing outside
   * debug mode), so no in-package alternative exists.
   */
  unusableSourceSlugReasons?: readonly SourceSlugRejectionReason[];
}

/**
 * One dropped-rule warning, reduced to what is safe to show a user.
 *
 * Both fields are closed unions. Nothing free-form is carried; see
 * {@link MergedPermissionsConfig.permissionDslDiagnostics}.
 */
export interface PermissionPolicyDiagnosticV1 {
  /**
   * A compiler diagnostic's code, or one of the two ALLOW-only inert forms the
   * compiler never sees ({@link INERT_PERMISSION_RULE_CODES}, P6.676). Still a
   * closed union, so the field stays path-free by type.
   */
  readonly code: PermissionDslDiagnosticV1['code'] | InertPermissionRuleCode;
  /**
   * The settings tier the dropped rule came from, when the diagnostic belongs
   * to one. Absent for a document-level diagnostic, which has no single rule
   * and therefore no scope to name — the same degrade the log line takes.
   */
  readonly scope?: PermissionDslScope; readonly document?: true; // F1.1002 — a whole file was dropped (`droppedSources`), not one rule
}

/**
 * Context for permissions checking (includes workspace/source/agent info)
 */
export interface PermissionsContext {
  workspaceRootPath: string;
  /** Active source slugs for source-specific rules */
  activeSourceSlugs?: string[];
  /** Revision-pinned permission documents supplied by the capability snapshot. */
  pinnedRevision?: string;
  projectTrusted?: boolean;
  /** Immutable host policy injected ahead of all mutable capability layers. */
  managedPermissionDsl?: PermissionDslV1;
  /**
   * `settings-reference.md#allowmanagedpermissionrulesonly` — "Make managed
   * settings the only settings source of permission rules. Claude Code then
   * ignores `allow`, `ask`, and `deny` rules in user, project, local, and
   * `--settings` files, ignores `--allowedTools`, hides the always-allow choices
   * in permission prompts, and stops saving new rules." Its **Scope** bullet
   * reads `Managed`.
   *
   * Set from `allowManagedPermissionRulesOnly`. It drops every SETTINGS-derived
   * DSL layer — the app default, the workspace file, per-source files, project
   * files and the `.claude/settings.json` allow/ask/deny blocks
   * `claudeSettingsPermissionDsl` compiles — and leaves
   * {@link managedPermissionDsl} and {@link sessionRules} standing. A session
   * rule is a hook's in-memory grant for this turn, not a settings file, and the
   * key names settings — the same section says so from the other side: "the
   * current session's `deny` and `ask` rules still apply".
   */
  managedPermissionRulesOnly?: boolean;
  pinnedConfigs?: Array<{
    config: PermissionsCustomConfig;
    sourceSlug?: string;
    scope?: PermissionDslScope;
  }>;
  /**
   * Session-lifetime rules a `PermissionRequest` hook added with
   * `destination: 'session'` (hooks.md § Permission update entries). Compiled
   * as one more layer at `workspace` scope — the same tier a session-scoped
   * skill grant uses, since permissions.md groups "CLI flags, `/permissions`,
   * or session rules" as one settings source anchored at the original cwd.
   */
  sessionRules?: readonly SessionPermissionRule[];
}

/** One session rule, with the rule string `removeRules`/`replaceRules` match on. */
export interface SessionPermissionRule {
  raw: string;
  action: PermissionDslRuleV1['action'];
  match: PermissionDslRuleV1['match'];
}

// ============================================================
// JSON Parser
// ============================================================

/**
 * Parse and validate permissions.json file
 */
export function parsePermissionsJson(
  content: string,
  /**
   * D3 — the absolute directory the settings file was read from, which is what
   * a `/`-anchored path rule resolves against (permissions.md: "Path patterns
   * share the `//`, `~/`, and `/` anchors from Read and Edit rules"). Absent
   * for a document with no file behind it, and an anchored rule in one of those
   * is dropped rather than left to fail its whole layer closed at compile.
   */
  sourceRoot?: string,
): PermissionsCustomConfig {
  const emptyConfig: PermissionsCustomConfig = {
    allowedBashPatterns: [],
    allowedMcpPatterns: [],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
    deniedPaths: [],
    deniedToolPatterns: [],
    allowedTools: [],
    disallowedTools: [],
    toolRules: [],
    blockedTools: [],
    blockedCommandHints: [],
    ...(sourceRoot === undefined ? {} : { sourceRoot }),
  };

  try {
    const json = parsePermissionJsonc(content);
    // A Claude settings file (`.claude/settings.json`,
    // `.claude/settings.local.json`) carries its rules under `permissions`, not
    // under our own keys, so it is recognized before the Nessy schema runs.
    const claudeSettings = claudeSettingsPermissionDsl(json, content, sourceRoot);
    if (claudeSettings) {
      return {
        ...emptyConfig,
        permissionDsl: claudeSettings.source,
        // P6.676 — only when there is something to say, so a clean document
        // carries no field and no consumer distinguishes "none" from "not
        // computed" (the same shape `permissionDslDiagnostics` already takes).
        ...(claudeSettings.inertCodes.length > 0
          ? { inertPermissionRuleCodes: claudeSettings.inertCodes }
          : {}),
      };
    }
    const result = PermissionsConfigSchema.safeParse(json);

    if (!result.success) {
      debug('[SafeMode] Validation errors:', result.error.issues);
      // Log specific errors for debugging
      for (const issue of result.error.issues) {
        debug(`[SafeMode]   - ${issue.path.join('.')}: ${issue.message}`);
      }
      if (json && typeof json === 'object' && !Array.isArray(json)
        && Object.prototype.hasOwnProperty.call(json, 'permissionDsl')) {
        return {
          ...emptyConfig,
          permissionDsl: {
            sourceDigest: createHash('sha256').update(content).digest('hex'),
            diagnostic: { code: 'invalid-document', message: 'Permission configuration is invalid.' },
          },
        };
      }
      return emptyConfig;
    }

    const data = result.data;

    // Normalize patterns (extract string from pattern objects, but NOT for bash - preserve comments)
    const normalizePatterns = (patterns: Array<string | { pattern: string; comment?: string }> | undefined): string[] => {
      if (!patterns) return [];
      return patterns.map(p => typeof p === 'string' ? p : p.pattern);
    };

    // For bash patterns, preserve comments for helpful error messages
    const normalizeBashPatterns = (patterns: Array<string | { pattern: string; comment?: string }> | undefined): PatternWithComment[] => {
      if (!patterns) return [];
      return patterns.map(p => {
        if (typeof p === 'string') {
          return { pattern: p };
        }
        return { pattern: p.pattern, comment: p.comment };
      });
    };

    return {
      allowedBashPatterns: normalizeBashPatterns(data.allowedBashPatterns),
      allowedMcpPatterns: normalizePatterns(data.allowedMcpPatterns),
      allowedApiEndpoints: data.allowedApiEndpoints ?? [],
      allowedWritePaths: normalizePatterns(data.allowedWritePaths),
      deniedPaths: normalizePatterns(data.deniedPaths),
      deniedToolPatterns: normalizePatterns(data.deniedToolPatterns),
      allowedTools: normalizePatterns(data.allowedTools),
      disallowedTools: normalizePatterns(data.disallowedTools),
      toolRules: data.toolRules ?? [],
      blockedTools: normalizePatterns(data.blockedTools),
      blockedCommandHints: data.blockedCommandHints ?? [],
      ...(data.permissionDsl === undefined ? {} : {
        permissionDsl: parsePermissionDslSourceV1(
          data.permissionDsl,
          createHash('sha256').update(content).digest('hex'),
        ),
      }),
    };
  } catch (error) {
    debug('[SafeMode] JSON parse error:', error);
    return /permissionDsl/.test(content)
      ? {
          ...emptyConfig,
          permissionDsl: {
            sourceDigest: createHash('sha256').update(content).digest('hex'),
            diagnostic: { code: 'invalid-jsonc', message: 'Permission DSL JSONC is invalid.' },
          },
        }
      : emptyConfig;
  }
}

/**
 * Compile a Claude settings file's `permissions` block into a DSL source.
 *
 * settings.md § Settings files makes `permissions.allow` / `.ask` / `.deny` the
 * shape of `.claude/settings.json` and `.claude/settings.local.json`; the rule
 * strings themselves are `permissions.md`'s, which `parseClaudeRuleString`
 * already owns. The two documents cannot be confused: a Nessy `permissions.json`
 * has no `permissions` key at all, and a Claude settings file has none of ours.
 *
 * A `/source`-anchored rule is DROPPED rather than compiled, matching the
 * managed tier's existing posture (`parseManagedClaudeRulesV1`): its anchor
 * needs the declaring settings file's directory, which the layer input does not
 * carry, and compiling it without one fails the whole layer closed — turning
 * one unsupported rule into a deny of everything.
 */
function claudeSettingsPermissionDsl(
  json: unknown,
  content: string,
  sourceRoot?: string,
): { source: PermissionDslSourceV1; inertCodes: readonly InertPermissionRuleCode[] } | undefined {
  const root = json as Record<string, unknown> | null;
  const block = root && typeof root === 'object' && !Array.isArray(root)
    ? root.permissions as Record<string, unknown> | undefined
    : undefined;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const rules: Array<{ id: string; action: ClaudeRuleAction; match: unknown; text: string }> = [];
  const inertCodes: InertPermissionRuleCode[] = [];
  let seen = false;
  for (const action of ['deny', 'ask', 'allow'] as const) {
    const entries = block[action];
    if (!Array.isArray(entries)) continue;
    seen = true;
    entries.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.trim().length === 0) return;
      const parsed = parseClaudeRuleString(entry, action, { knownToolNames: PERMISSION_RULE_TOOL_NAMES });
      if (!parsed.rule) {
        // P6.676 — the code and the reason, not just "inert". This line used to
        // name neither, so the two ALLOW-only forms below reached `debug()`
        // without their own message and reached the user not at all.
        debug(parsed.warning
          ? `[Permissions] Claude settings ${action} rule is inert (${parsed.warning.code}): ${parsed.warning.message}`
          : `[Permissions] Claude settings ${action} rule is inert, skipping: ${entry}`);
        if (parsed.warning && isInertPermissionRuleCode(parsed.warning.code)) {
          inertCodes.push(parsed.warning.code);
        }
        return;
      }
      // permissions.md: "a deny or ask rule whose tool name matches no known
      // tool produces a startup warning to catch typos". The warning rides
      // ALONGSIDE a rule here — the rule installs and matches nothing — so it
      // must be read independently of `parsed.rule`, which is what made it
      // unreachable.
      if (parsed.warning) {
        debug(`[Permissions] Claude settings ${action} rule warning (${parsed.warning.code}): ${parsed.warning.message}`);
      }
      // D3. EVERY matcher that can carry the anchor, not just `pathGlob`:
      // `Cd(/x)` compiles to a `cdPath` with the same anchor. With a settings
      // source the rule is kept and the layer anchors it there; WITHOUT one it
      // is still dropped, because letting it through throws at compile and the
      // compiler catches per LAYER — one unresolvable anchor would become a
      // deny of every tool. The two halves have to agree, which is why the same
      // `sourceRoot` decides here and rides the layer below.
      if (parsed.rule.match.anchor === 'source' && sourceRoot === undefined) {
        debug(
          `[Permissions] Claude settings ${action} rule is anchored at its settings source, `
          + `but this document has no directory to anchor to, so it cannot be enforced: ${entry}`,
        );
        return;
      }
      // P2.445 — `entry` is the rule string the user typed into their settings
      // file, and it is the only spelling of this rule they have ever seen. The
      // id beside it is positional (`claude-settings-deny-3`), so a refusal that
      // named only the id would name nothing the user could search for.
      rules.push({ id: `claude-settings-${action}-${index}`, action, match: parsed.rule.match, text: entry });
    });
  }
  if (!seen) return undefined;
  return {
    source: {
      sourceDigest: createHash('sha256').update(content).digest('hex'),
      document: { version: 1, rules },
    },
    inertCodes,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sessionRulesDigest(rules: readonly SessionPermissionRule[]): string {
  return createHash('sha256').update(canonicalJson(rules)).digest('hex');
}

function managedPermissionDslDigest(document: PermissionDslV1): string {
  return createHash('sha256').update(canonicalJson(document)).digest('hex');
}

/**
 * Digest of one published `pinnedConfigs` array, memoized by ARRAY IDENTITY —
 * and only for an array that is frozen (P2.201).
 *
 * ## The measurement, because the memo one level up was not the bottleneck
 *
 * `mergedConfigs` already memoizes the merged config, and it is keyed by
 * content, which is correct. What nobody measured is that computing that key
 * costs about what rebuilding the merge costs, so the memo was paying for
 * itself and no more. Measured 2026-09-03 on this repo (loaded box, load 7–16,
 * `bun`, µs per op, warm/cold via a fresh `pinnedRevision`):
 *
 * | pinned layers | warm `getMergedConfig` | cold | `canonicalJson`+sha256 alone |
 * | --- | --- | --- | --- |
 * | 1 | 6.44 | 7.01 | 3.56 |
 * | 20 | 63.54 | 71.28 | 61.90 |
 * | 50 | 147.96 | 211.61 | 173.92 |
 *
 * At 20 layers the digest is essentially the whole warm hit. A `WeakMap` hit
 * on the same arrays measured **0.01–0.02 µs at every size** — which is the
 * "0.2 µs lookup" the row budgeted for, and four orders of magnitude below the
 * hash it replaces. (The digest column was measured with a replica of
 * {@link canonicalJson}, so read it as attribution, not as an exact split;
 * the 50-layer row's warm figure was taken at a different load moment.)
 *
 * ## Why identity is a SOUND key here, and only here
 *
 * Identity keying is normally wrong for content-addressed caches: the same
 * array can be mutated in place and keep its identity. The sole producer of
 * `pinnedConfigs` — `core/permission-manager.ts`'s
 * `setCapabilityPermissionLayers` — publishes through `freezePublishedLayers`,
 * a deep freeze that reaches the array itself, and that freeze is exactly what
 * P2.55 landed for this purpose. So the guard is not "we know the caller": it
 * is `Object.isFrozen`, checked here, every call. An unfrozen array — any
 * inline-built context, of which several exist — takes the hash as before, so
 * this can never serve a stale digest for a mutated layer set.
 *
 * The memo is a `WeakMap`, so a published generation that is replaced is
 * collected with its entry; nothing accumulates across sessions.
 */
const pinnedConfigsDigests = new WeakMap<object, string>();

function pinnedConfigsDigest(pinnedConfigs: object): string {
  if (!Object.isFrozen(pinnedConfigs)) {
    return createHash('sha256').update(canonicalJson(pinnedConfigs)).digest('hex');
  }
  const memoized = pinnedConfigsDigests.get(pinnedConfigs);
  if (memoized !== undefined) return memoized;
  const digest = createHash('sha256').update(canonicalJson(pinnedConfigs)).digest('hex');
  pinnedConfigsDigests.set(pinnedConfigs, digest);
  return digest;
}

/**
 * Announce the permission compiler's diagnostics on the app's diagnostic stream.
 *
 * `managed-settings.md#keys-that-fail-closed` is the contract, and it has two
 * halves: "User, project, and local settings files remain strict: a file whose
 * JSON or top-level shape fails validation is rejected as a whole and reported,
 * and an individual entry that fails, such as a malformed permission rule, is
 * skipped with a warning while the rest of the file applies." P2.270 shipped
 * the skipping. The warning was written into
 * `CompiledPermissionDslV1.diagnostics` and read by NOBODY, so until this
 * function existed a project `.claude/settings.json` carrying one Windows-style
 * path lost that rule in complete silence — half a contract, in the silent
 * direction.
 *
 * `debug()` is not a new channel invented for this: it is the same stream the
 * two NEIGHBOURING drops already write to — the parse-time inert and
 * unanchored drops inside `claudeSettingsPermissionDsl`, and the managed-anchor
 * drop in `buildMergedConfig`. All three halves of "your rule was dropped" now
 * land on one stream, keyed the same way, so whoever is diagnosing a policy
 * reads one place instead of three. The compile-time half deliberately does NOT
 * log from inside `compilePermissionDslV1`: a pure compiler that writes to a log
 * is one you cannot test or reuse, so the diagnostics come out in the return
 * value and the CALLER routes them.
 *
 * ONE line per diagnostic, never an aggregate. The page says "with a warning for
 * each"; a user told only that "your settings had problems" cannot repair the
 * rule they lost, and the diagnostic already names it.
 *
 * A dropped rule's (F1.831: or whole document's) line also names the SCOPE it came from, which points at
 * the file to edit. The lookup is keyed by diagnostic IDENTITY because `compilePermissionDslV1` pushes the
 * very same object into `diagnostics` and into `droppedRules[]`/`droppedSources[]`; if that ever stops
 * being true the line degrades to the unscoped wording rather than to a wrong scope.
 *
 * Called once per merged-config BUILD, not per request — `getMergedConfig`
 * caches — which is the "startup warning" cadence
 * `permissions.md#tool-name-wildcards` describes for the sibling case ("A deny
 * or ask rule whose tool name matches no known tool produces a startup warning
 * to catch typos").
 */
function reportPermissionDslDiagnostics(program: CompiledPermissionDslV1): readonly PermissionPolicyDiagnosticV1[] {
  if (program.diagnostics.length === 0) return EMPTY_PERMISSION_POLICY_DIAGNOSTICS;
  const scopeByDiagnostic = new Map<PermissionDslDiagnosticV1, PermissionDslScope>();
  const documents = program.droppedSources ?? []; // F1.831 — a whole unreadable file names its scope too
  for (const dropped of [...program.droppedRules, ...documents]) scopeByDiagnostic.set(dropped.diagnostic, dropped.scope);
  const safe: PermissionPolicyDiagnosticV1[] = [];
  for (const diagnostic of program.diagnostics) {
    const scope = scopeByDiagnostic.get(diagnostic), wholeFile = documents.some(dropped => dropped.diagnostic === diagnostic);
    debug(scope === undefined
      ? `[Permissions] Permission policy diagnostic (${diagnostic.code}): ${diagnostic.message}`
      : `[Permissions] Permission ${wholeFile ? 'document' : 'rule'} dropped from ${scope} settings (${diagnostic.code}): ${diagnostic.message}`);
    // P2.276 — the SAME join, handed to the host so a user can be told without
    // a debug flag. Built here rather than at the consumer so the log line and
    // the notice can never name different scopes (nor, F1.1002, file vs rule).
    safe.push(Object.freeze(scope === undefined ? { code: diagnostic.code } : { code: diagnostic.code, scope, ...(wholeFile ? { document: true as const } : {}) }));
  }
  return Object.freeze(safe);
}

/** Shared empty result, so the common no-diagnostics path allocates nothing. */
const EMPTY_PERMISSION_POLICY_DIAGNOSTICS: readonly PermissionPolicyDiagnosticV1[] = Object.freeze([]);

/**
 * Validate a regex pattern string, return null if invalid
 */
function validateRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function compileBlockedCommandHint(hint: BlockedCommandHintRule): CompiledBlockedCommandHint | null {
  const command = hint.command.trim().toLowerCase();
  if (!command) return null;

  let whenNotMatchingRegex: RegExp | undefined;
  if (hint.whenNotMatching) {
    const compiled = validateRegex(hint.whenNotMatching);
    if (!compiled) {
      debug(`[Permissions] Invalid blockedCommandHints.whenNotMatching regex, skipping: ${hint.whenNotMatching}`);
      return null;
    }
    whenNotMatchingRegex = compiled;
  }

  return {
    command,
    reason: hint.reason,
    context: hint.context,
    tryInstead: hint.tryInstead,
    example: hint.example,
    whenNotMatching: hint.whenNotMatching,
    whenNotMatchingRegex,
  };
}

function addDeniedPath(merged: MergedPermissionsConfig, pattern: string): void {
  if (!merged.deniedPaths.includes(pattern)) {
    merged.deniedPaths.push(pattern);
  }
}

function addDeniedToolPattern(merged: MergedPermissionsConfig, pattern: string): void {
  if (!merged.deniedToolPatterns.includes(pattern)) {
    merged.deniedToolPatterns.push(pattern);
  }
}

/**
 * Validate permissions config and return errors
 */
export function validatePermissionsConfig(config: PermissionsConfigFile): string[] {
  const errors: string[] = [];

  // Validate regex patterns
  const checkPatterns = (patterns: Array<string | { pattern: string }> | undefined, name: string) => {
    if (!patterns) return;
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      if (!p) continue;
      const patternStr = typeof p === 'string' ? p : p.pattern;
      if (!validateRegex(patternStr)) {
        errors.push(`${name}[${i}]: Invalid regex pattern: ${patternStr}`);
      }
    }
  };

  checkPatterns(config.allowedBashPatterns, 'allowedBashPatterns');
  checkPatterns(config.allowedMcpPatterns, 'allowedMcpPatterns');
  checkPatterns(config.deniedToolPatterns, 'deniedToolPatterns');

  // Validate API endpoint patterns
  if (config.allowedApiEndpoints) {
    for (let i = 0; i < config.allowedApiEndpoints.length; i++) {
      const rule = config.allowedApiEndpoints[i];
      if (rule && !validateRegex(rule.path)) {
        errors.push(`allowedApiEndpoints[${i}].path: Invalid regex pattern: ${rule.path}`);
      }
    }
  }

  // Validate blocked command hint conditional regex patterns
  if (config.blockedCommandHints) {
    for (let i = 0; i < config.blockedCommandHints.length; i++) {
      const hint = config.blockedCommandHints[i];
      if (hint?.whenNotMatching && !validateRegex(hint.whenNotMatching)) {
        errors.push(`blockedCommandHints[${i}].whenNotMatching: Invalid regex pattern: ${hint.whenNotMatching}`);
      }
    }
  }

  return errors;
}

// ============================================================
// Storage Functions
// ============================================================

/**
 * Get path to workspace permissions.json
 */
export function getWorkspacePermissionsPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'permissions.json');
}

/**
 * Get path to source permissions.json
 */
export function getSourcePermissionsPath(workspaceRootPath: string, sourceSlug: string): string {
  return join(getSourcePath(workspaceRootPath, sourceSlug), 'permissions.json');
}

/**
 * Load workspace-level permissions config
 */
export function loadWorkspacePermissionsConfig(workspaceRootPath: string): PermissionsCustomConfig | null {
  const path = getWorkspacePermissionsPath(workspaceRootPath);
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    const config = parsePermissionsJson(content, workspaceRootPath);
    debug(`[Permissions] Loaded workspace config from ${path}:`, config);
    return config;
  } catch (error) {
    debug(`[Permissions] Error loading workspace config:`, error);
    return null;
  }
}

/**
 * Load source-level permissions config
 */
export function loadSourcePermissionsConfig(
  workspaceRootPath: string,
  sourceSlug: string
): PermissionsCustomConfig | null {
  const path = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    const config = parsePermissionsJson(content, getSourcePath(workspaceRootPath, sourceSlug));
    debug(`[Permissions] Loaded source config from ${path}:`, config);
    return config;
  } catch (error) {
    debug(`[Permissions] Error loading source config:`, error);
    return null;
  }
}

// ============================================================
// Raw Load / Save (for CLI CRUD — preserves schema-level structure)
// ============================================================

/**
 * Load raw PermissionsConfigFile from a workspace permissions.json.
 * Returns the Zod-parsed schema object (not the normalized runtime config).
 * Returns null if the file doesn't exist.
 */
export function loadRawWorkspacePermissions(workspaceRootPath: string): PermissionsConfigFile | null {
  const filePath = getWorkspacePermissionsPath(workspaceRootPath);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const json = safeJsonParse(content);
  const result = PermissionsConfigSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Load raw PermissionsConfigFile from a source permissions.json.
 * Returns null if the file doesn't exist.
 */
export function loadRawSourcePermissions(workspaceRootPath: string, sourceSlug: string): PermissionsConfigFile | null {
  const filePath = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const json = safeJsonParse(content);
  const result = PermissionsConfigSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Save a PermissionsConfigFile to the workspace permissions.json.
 */
export function saveWorkspacePermissions(workspaceRootPath: string, config: PermissionsConfigFile): void {
  const filePath = getWorkspacePermissionsPath(workspaceRootPath);
  mkdirSync(workspaceRootPath, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  permissionsConfigCache.invalidateWorkspace(workspaceRootPath);
}

/**
 * Save a PermissionsConfigFile to a source permissions.json.
 */
export function saveSourcePermissions(workspaceRootPath: string, sourceSlug: string, config: PermissionsConfigFile): void {
  const filePath = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  const sourceDir = getSourcePath(workspaceRootPath, sourceSlug);
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  permissionsConfigCache.invalidateSource(workspaceRootPath, sourceSlug);
}

// ============================================================
// Codex execpolicy projection (P3.1)
//
// The DURABLE store of a codex "Always Allow" grant is the workspace
// `permissions.json`, written through {@link saveWorkspacePermissions} as a
// structural `bash` ALLOW rule in `permissionDsl`. The codex `rules/*.rules`
// layer is a pure PROJECTION of that store, re-derived on every home build.
// These two helpers are the one direction between them: MERGE writes the store,
// COLLECT reads it back for the projection.
//
// P2.400 · WHICH SCOPE A PROJECTED RULE CAME FROM — ASKED, MEASURED, REFUSED.
// P6.1's residue says a codex refusal "cannot say WHICH SCOPE that rule came
// from — project file, workspace file, or durable grant — because the collectors
// flatten scope", and prices the fix as a parameter threaded through all three
// collectors. Measured at `eea2f4448`, there is no flattening to undo:
//
//  - The three collectors take ONE `PermissionsConfigFile`, and the tree has ONE
//    producer for all three lists — `CodexAgent`'s three private wrappers, each
//    passing `loadRawWorkspacePermissions(workspaceRootPath)`, i.e. the SAME
//    single file (`codex-agent.ts:1585`/`:1592`/`:1598` →
//    `execpolicy{Allow,Deny,Prompt}Prefixes`). `git grep` over `packages` for
//    those three option names finds that site and no other, with
//    `config-writer.ts:2564` as the one consumer.
//  - So every projected rule already has ONE scope, `workspace`, by
//    construction, and a durable grant is a rule inside that same file. A
//    `scope` parameter would carry a CONSTANT to a call site that already knows
//    it: the justification would gain a word and no reader would gain a fact.
//    Refused for that reason, not for cost.
//  - The four other scopes the merged policy compiles (`managed`, `global`,
//    `project`, `plugin` — `pi-harness/permission-dsl.ts`'s
//    `PermissionDslScope`) never reach this projection AT ALL. That is the real
//    residue, and it is a narrower defence in depth rather than an unenforced
//    rule: `CodexAgent.consultPermissionRules` evaluates the FULL merged policy
//    on codex's own approval path, and `findNonNegotiableFloors` holds the floor.
//  - THE CONDITION UNDER WHICH THIS REFUSAL EXPIRES, written down so the next
//    lane does not re-derive it: the day anything feeds these collectors a
//    second file, the justification's unstated "this came from the workspace
//    file" silently becomes false. Widening the input and naming the scope in
//    `DENY_JUSTIFICATION_LEAD`/`PROMPT_JUSTIFICATION_LEAD`
//    (`codex-responses-adapter/src/config-writer.ts`) are then ONE change — and
//    the longer string has to be re-proven against the bundled
//    `codex-app-server` by `codex-agent-server`'s `config-warning-live.test.ts`,
//    because a rules file that fails to parse fails OPEN and WHOLE-FILE, taking
//    every deny floor with it.
// ============================================================

/**
 * The execpolicy allow-prefixes carried by a workspace permissions file's DSL —
 * one token array per structural `bash` ALLOW rule, ready to project into a
 * codex `rules/*.rules` file via `buildCodexExecpolicyRules`.
 *
 * Reads the durable store's `permissionDsl` document (`{ version, rules }`, typed
 * `unknown` on disk) defensively: only `action: 'allow'` rules whose matcher is
 * the STRUCTURAL bash form `{ kind: 'bash', executable, args? }` yield a prefix
 * `[executable, ...args]`. That structural form maps one-to-one onto an
 * `ExecPolicyAmendment`; the Claude pattern form (`{ kind: 'bash', pattern }`)
 * has no clean token prefix and is deliberately not projected. `ask` rules are
 * not projected either: codex's `prompt` decision prompts CODEX's own approval
 * loop, which for us is the same card the unmatched path already produces, so
 * projecting them buys nothing and could only differ from our own answer.
 *
 * DENY rules ARE projected — by {@link collectExecpolicyDenyPrefixes}. This
 * comment used to read "a `prefix_rule` only expresses allow", which is FALSE and
 * was load-bearing: it was the stated reason only allows were sent. Both the
 * published contract and the shipped binary say otherwise, and they agree with
 * each other.
 *
 * `learn.chatgpt.com/docs/agent-configuration/rules.md` § Understand rule
 * fields (`#understand-rule-fields`), fetched 2026-08-25 and RE-FETCHED
 * 2026-09-03 byte-identical (134 lines, md5
 * `b901eebf5a984e0bf0886d8bd86eef50` both times, which is why the line anchors
 * below are still exact). The host prefix is P2.377: this is a codex page, it
 * 404s on `code.claude.com/docs/en/` and is in no page of
 * `scripts/claude-doc-pages.tsv`, and a bare page name is unambiguous only
 * inside one corpus while this fork cites two. `:60`: "`decision` **(defaults to
 * `"allow"`)**: The action to take when the rule matches. Codex applies the most
 * restrictive decision when more than one rule matches (`forbidden` > `prompt` >
 * `allow`)." And `:63`: "`forbidden`: Block the request without prompting."
 *
 * The bundled `codex-app-server` (darwin-arm64, md5
 * `eb2144664b1c4eb0697b69b4b242b737`, 178 126 224 bytes) carries the same three
 * as an enum — `execpolicy`'s `Decision` variants appear as the adjacent literals
 * `Allow`/`Prompt`/`Forbidden` beside `InvalidDecision` — and one string states
 * codex's OWN merge rule outright: " has decision 'allow', which is not permitted
 * in requirements.toml: Codex merges these rules with other config and uses the
 * most restrictive result (use 'prompt' or 'forbidden')".
 *
 * DRIVEN, not read (2026-08-25, the shipped binary over stdio with a scratch
 * `CODEX_HOME`): `decision="forbidden"` loads as `decision: Forbidden`,
 * `decision="prompt"` as `decision: Prompt`, `decision="allow"` as
 * `decision: Allow` (the baseline control), while `decision="nonsense"` is
 * rejected with `error: invalid decision: nonsense` and syntax garbage produces
 * no policy at all — two working negative controls, so the three positives are
 * not a rig that says yes to everything.
 *
 * WHY THE PROJECTION IS DEFENCE IN DEPTH AND NOT A FLOOR, measured on the same
 * rig and the reason `core/pre-tool-use.ts` keeps the floor host-side:
 *  - IT FAILS OPEN, per file and totally. A file holding one good `allow` rule
 *    and one malformed rule loaded ZERO rules and reported "Error parsing rules;
 *    custom rules not applied." (positive control: the same two rules, both
 *    well-formed, loaded both). One typo disarms the whole projection.
 *  - IT DOES NOT SPLIT THE DANGEROUS CLASS. `rules.md:100`-`:117`: a script using
 *    redirection, `$(...)`, `FOO=bar`, `*`/`?` or control flow is not split, and
 *    "the entire invocation is treated as ["bash", "-lc", "<full script>"] and
 *    your rules are applied to that **single** invocation" — so a prefix rule on
 *    `rm` never sees the `rm` inside it.
 *  - WE CANNOT TEST IT THE DOCUMENTED WAY. `codex execpolicy check` is documented
 *    at `rules.md:124` but ABSENT from our artifact (`execpolicy` → "error:
 *    unexpected argument 'execpolicy' found", 2026-08-25), and the `match`/
 *    `not_match` inline examples validate against raw argv, so neither can
 *    demonstrate wrapper behaviour.
 *
 * ## A cwd-SCOPED rule projects NOTHING, on all three tiers (P2.400)
 *
 * The structural bash matcher has a third field, `cwdRoot`, which narrows the
 * rule to requests whose cwd is inside that root — `matchesRule` in
 * `pi-harness/permission-dsl.ts`: `matcher.cwdRoot ? within(matcher.cwdRoot,
 * cwd) : true`, compiled at `compileMatcher`'s `bash` case and exercised by
 * `permission-dsl.test.ts`. execpolicy has nothing to project that onto: the
 * parser's builtin keyword set, read out of the bundled `codex-app-server`
 * (darwin-arm64, `rust-v0.150.1`, the `execpolicy/src/parser.rs` string table)
 * is `pattern`, `match`, `not_match`, `justification`, `prefix_rule`,
 * `network_rule`, `paths`, `host_executable` — no directory field of any kind.
 *
 * A projected `cwdRoot` rule is therefore the user's rule with its condition
 * DELETED, and that is wrong in a different direction per tier — worst on the
 * tier the user clicked: an `allow` becomes an unconditional grant that ALSO
 * removes the sandbox for that prefix (P3.80), a `deny` forbids where the user
 * never denied, an `ask` asks where the user never asked. The last two are the
 * same over-tightening the interior-wildcard refusal already rules out; the
 * first is a widening, which is worse. So all three collectors skip it, and no
 * enforcement is lost: `CodexAgent.consultPermissionRules` evaluates the same
 * rule WITH its cwd on codex's own approval path, so a cwd-scoped grant still
 * auto-approves inside its root and a cwd-scoped deny still refuses there.
 *
 * The check sits AHEAD of the pattern branch in the deny and prompt collectors
 * on purpose: a raw matcher carrying both `pattern` and `cwdRoot` is one
 * `compileMatcher` rejects outright ("invalid bash pattern matcher"), so the
 * host drops that rule and projecting it would invent a rule nobody has.
 *
 * A wildcard inside a STRUCTURAL `executable`/`args` is left alone rather than
 * skipped, and the reason is a read rather than a measurement: the DSL matches
 * those through its own `wildcard()`, while an execpolicy pattern element is a
 * literal string or a declared alternation, so `["git*"]` matches nothing on
 * codex — inert in both directions, neither widening nor tightening. The
 * PATTERN form's wildcards are refused below for the different reason that
 * their literal head is not inert.
 *
 * Malformed input degrades to an empty list rather than throwing (protocol-drift
 * caveat).
 */
export function collectExecpolicyAllowPrefixes(file: PermissionsConfigFile | null | undefined): string[][] {
  const dsl = file?.permissionDsl;
  if (!dsl || typeof dsl !== 'object') return [];
  const rules = (dsl as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return [];
  const prefixes: string[][] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const { action, match } = rule as { action?: unknown; match?: unknown };
    if (action !== 'allow' || !match || typeof match !== 'object') continue;
    const m = match as { kind?: unknown; executable?: unknown; args?: unknown; pattern?: unknown; cwdRoot?: unknown };
    if (m.kind !== 'bash' || m.pattern !== undefined) continue;
    // A cwd-scoped grant has no execpolicy form, and projecting it would drop
    // the condition — an unconditional allow that also unsandboxes the prefix.
    if (m.cwdRoot !== undefined) continue;
    if (typeof m.executable !== 'string' || m.executable.length === 0) continue;
    let args: string[] = [];
    if (m.args !== undefined) {
      if (!Array.isArray(m.args) || m.args.some(a => typeof a !== 'string')) continue;
      args = m.args as string[];
    }
    prefixes.push([m.executable, ...args]);
  }
  return prefixes;
}

/**
 * The execpolicy DENY-prefixes carried by a workspace permissions file's DSL —
 * one token array per `deny` rule whose bash matcher has a clean literal prefix,
 * ready to project as `prefix_rule(..., decision="forbidden")` (P2.141b).
 *
 * DEFENCE IN DEPTH, NOT A FLOOR. The bounding is in
 * {@link collectExecpolicyAllowPrefixes}'s docstring, measured on the shipped
 * binary: one malformed line drops EVERY custom rule in the file (fail-open), and
 * codex applies rules to a single `["bash","-lc","<script>"]` invocation whenever
 * the script uses `$FOO`, `*`, `$(...)`, a redirect or control flow — which is
 * the whole dangerous class. So this makes the common case refuse one layer
 * earlier and carries no guarantee. The guarantee is `core/pre-tool-use.ts`'s
 * host-side floor, which runs on the codex approval path too (P2.140).
 *
 * ## Which deny shapes project, and why the rest do not
 *
 * The durable store's deny rules are the PATTERN form of the bash matcher —
 * measured through `parseClaudeRuleString`, 2026-08-25: `Bash(rm:*)` parses to
 * `{action:'deny', match:{kind:'bash', pattern:'rm:*'}}`. So this reads
 * `match.pattern`, which is exactly the field the allow collector SKIPS, plus the
 * structural `{executable, args}` form for symmetry with it.
 *
 * A pattern projects only when its wildcard is absent or is the documented
 * trailing `:*` ("this command with any arguments"):
 *  - `rm:*` → `["rm"]`
 *  - `rm -rf /` → `["rm","-rf","/"]` (a prefix rule forbids a SUPERSET of an
 *    exact command, and forbidding more is tightening, which is always allowed)
 *  - `sudo rm:*` → `["sudo","rm"]`
 *
 * A pattern with an INTERIOR wildcard (`rm -rf *`, `git * push`) is skipped. Its
 * literal head would be a legal prefix rule — but `["rm","-rf"]` forbids
 * `rm -rf build`, which the user's `rm -rf *` never denied. Over-tightening a
 * deny is still a wrong answer, so the honest projection is none.
 */
export function collectExecpolicyDenyPrefixes(file: PermissionsConfigFile | null | undefined): string[][] {
  const dsl = file?.permissionDsl;
  if (!dsl || typeof dsl !== 'object') return [];
  const rules = (dsl as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return [];
  const prefixes: string[][] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const { action, match } = rule as { action?: unknown; match?: unknown };
    if (action !== 'deny' || !match || typeof match !== 'object') continue;
    const m = match as { kind?: unknown; executable?: unknown; args?: unknown; pattern?: unknown; cwdRoot?: unknown };
    if (m.kind !== 'bash') continue;
    // Ahead of the pattern branch deliberately: see
    // {@link collectExecpolicyAllowPrefixes}'s docstring.
    if (m.cwdRoot !== undefined) continue;
    if (typeof m.pattern === 'string') {
      const tokens = execpolicyPrefixFromBashPattern(m.pattern);
      if (tokens) prefixes.push(tokens);
      continue;
    }
    if (typeof m.executable !== 'string' || m.executable.length === 0) continue;
    let args: string[] = [];
    if (m.args !== undefined) {
      if (!Array.isArray(m.args) || m.args.some(a => typeof a !== 'string')) continue;
      args = m.args as string[];
    }
    prefixes.push([m.executable, ...args]);
  }
  return prefixes;
}

/**
 * The execpolicy PROMPT-prefixes carried by a workspace permissions file's DSL —
 * one token array per `ask` rule whose bash matcher has a clean literal prefix,
 * ready to project as `prefix_rule(..., decision="prompt")` (P6.1).
 *
 * ## Why the middle tier needs an emission at all, when `deny` and `allow` do
 *
 * The DSL has three actions and codex was told about two of them. That was not
 * a symmetry oversight: an `ask` rule already reaches the human on the codex
 * path — `CodexAgent.consultPermissionRules` returns `null` for it and the card
 * is shown — so for every call codex ASKS ABOUT, the middle tier already works.
 *
 * The gap is the calls codex does NOT ask about. `codexSandboxConfigForMode`
 * emits `approval_policy = "on-request"` for six of the seven modes, and the
 * release `config-schema.json` describes that as "The model decides when to ask
 * the user for approval"; `untrusted` (the seventh, after the `never` degrade)
 * "auto-approve[s]" `is_safe_command()` reads. On top of that, our own durable
 * grants are projected as `decision="allow"`, which the generated
 * `ExecPolicyAmendment` describes as "letting the agent bypass approval". Every
 * one of those is a command that never becomes an approval request, so
 * `consultPermissionRules` never runs and the user's `ask` rule decides nothing.
 * That is the "silently disappears" half, and it is the half only codex can
 * close, because the decision is made inside codex before we are consulted.
 *
 * ## Why codex's own vocabulary, rather than a host-side mechanism
 *
 * `Decision::Prompt` is codex's own middle tier — read from `execpolicy/src/decision.rs`
 * at `rust-v0.150.1`, the tag shipped when this was read (today's is `manifest.json`'s
 * `upstream.tag`): "Request explicit user approval; rejected outright when running with
 * `approval_policy="never"`". `Evaluation::from_matches` (`execpolicy/src/policy.rs`)
 * takes `.max()` over every matched rule's decision, and `Decision` derives `Ord` in
 * declaration order `Allow < Prompt < Forbidden` — so a projected `prompt` OVERRIDES an
 * `allow` from codex's own built-in policy for the same command, which is exactly what a
 * user's `ask` rule means. `core/exec_policy.rs` then maps it to
 * `ExecApprovalRequirement::NeedsApproval`, i.e. an
 * `item/commandExecution/requestApproval` — the seam `handleServerRequest` already
 * answers on, where the `ask` tier already behaves correctly.
 *
 * Under `approval_policy = "never"` the same rule becomes
 * `ExecApprovalRequirement::Forbidden` instead (`prompt_is_rejected_by_policy`).
 * That is the right answer rather than a regression: `never` is emitted only for
 * `dontAsk` with the sandbox master switch ON, and `dontAsk`'s own contract is
 * "never prompt; run what the rules pre-approve, deny the rest".
 *
 * ## Which ask shapes project
 *
 * Exactly the shapes {@link collectExecpolicyDenyPrefixes} accepts, through the
 * same helper, and for the same reason turned around: an interior wildcard's
 * literal head would OVER-prompt — `["git","push"]` from `git push * --force`
 * asks about `git push origin`, which the user's rule never covered. Over-asking
 * is a wrong answer too, so the honest projection is none.
 *
 * Same fail-open bound as the other two lists: one malformed line drops every
 * rule in the file, so this is defence in depth, never a floor.
 */
export function collectExecpolicyPromptPrefixes(file: PermissionsConfigFile | null | undefined): string[][] {
  const dsl = file?.permissionDsl;
  if (!dsl || typeof dsl !== 'object') return [];
  const rules = (dsl as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return [];
  const prefixes: string[][] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const { action, match } = rule as { action?: unknown; match?: unknown };
    if (action !== 'ask' || !match || typeof match !== 'object') continue;
    const m = match as { kind?: unknown; executable?: unknown; args?: unknown; pattern?: unknown; cwdRoot?: unknown };
    if (m.kind !== 'bash') continue;
    // Ahead of the pattern branch deliberately: see
    // {@link collectExecpolicyAllowPrefixes}'s docstring.
    if (m.cwdRoot !== undefined) continue;
    if (typeof m.pattern === 'string') {
      const tokens = execpolicyPrefixFromBashPattern(m.pattern);
      if (tokens) prefixes.push(tokens);
      continue;
    }
    if (typeof m.executable !== 'string' || m.executable.length === 0) continue;
    let args: string[] = [];
    if (m.args !== undefined) {
      if (!Array.isArray(m.args) || m.args.some(a => typeof a !== 'string')) continue;
      args = m.args as string[];
    }
    prefixes.push([m.executable, ...args]);
  }
  return prefixes;
}

/**
 * The token prefix a Claude bash PATTERN denies, or `null` when it has none.
 *
 * Accepts a fully literal pattern and the trailing-`:*` form, and refuses
 * everything else — see {@link collectExecpolicyDenyPrefixes} for why an interior
 * wildcard must yield nothing rather than its literal head.
 */
function execpolicyPrefixFromBashPattern(pattern: string): string[] | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return null;
  const head = trimmed.endsWith(':*') ? trimmed.slice(0, -2).trim() : trimmed;
  if (head.length === 0) return null;
  // No wildcard may survive into a token: codex matches pattern elements
  // literally (or as a declared alternation), so a `*` inside one would be a
  // rule that matches a literal asterisk and nothing else.
  if (/[*?]/.test(head)) return null;
  const tokens = head.split(/\s+/).filter(token => token.length > 0);
  return tokens.length > 0 ? tokens : null;
}

/**
 * Add one execpolicy allow-prefix to a workspace permissions file's DSL as a
 * structural `bash` ALLOW rule, returning the merged file to hand to
 * {@link saveWorkspacePermissions}. Pure — no I/O.
 *
 * The rule id is derived from the tokens, so re-granting the same prefix is
 * idempotent: a rule with that id already present leaves the file unchanged.
 * Every other field of the file, and every unrelated DSL rule, is preserved
 * (the store may carry rules from other writers, and merge-preserve is the
 * contract). `null`/absent input starts a fresh `{ version, rules: [] }`
 * document. An all-blank token set is a no-op.
 */
export function mergeExecpolicyAllowGrant(
  file: PermissionsConfigFile | null | undefined,
  tokens: readonly string[],
): PermissionsConfigFile {
  const clean = tokens.filter((t): t is string => typeof t === 'string' && t.length > 0);
  const base: PermissionsConfigFile = file ? { ...file } : {};
  if (clean.length === 0) return base;
  const [executable, ...args] = clean;
  const dsl = base.permissionDsl && typeof base.permissionDsl === 'object'
    ? (base.permissionDsl as { version?: unknown; rules?: unknown })
    : {};
  const rules: unknown[] = Array.isArray(dsl.rules) ? [...dsl.rules] : [];
  const id = `codex-execpolicy-${createHash('sha256').update(clean.join('\u0000')).digest('hex').slice(0, 16)}`;
  if (rules.some(r => r && typeof r === 'object' && (r as { id?: unknown }).id === id)) return base;
  rules.push({
    id,
    action: 'allow',
    match: { kind: 'bash', executable, ...(args.length > 0 ? { args } : {}) },
  });
  base.permissionDsl = {
    version: typeof dsl.version === 'number' ? dsl.version : NESSY_PERMISSION_DSL_VERSION,
    rules,
  };
  return base;
}

// ============================================================
// API Endpoint Checking
// ============================================================

/**
 * Check if an API call is allowed by endpoint rules
 */
export function isApiEndpointAllowed(
  method: string,
  path: string,
  config: MergedPermissionsConfig, toolName?: string, // F1.1152: a source's own rule grants only its api_<slug> tool
): boolean {
  const upperMethod = method.toUpperCase();

  // GET is always allowed
  if (upperMethod === 'GET') return true;

  // Check fine-grained endpoint rules
  for (const rule of config.allowedApiEndpoints) {
    if (rule.method === upperMethod && rule.pathPattern.test(path) && apiEndpointRuleGrantsTool(rule, toolName)) {
      return true;
    }
  }

  return false;
}

// ============================================================
// Config Cache
// ============================================================

/**
 * One cached merged config plus the facts invalidation needs about the context
 * that produced it.
 *
 * These facts used to be recovered by PARSING the cache key, which is what made
 * `invalidateSource` wrong: the key's sources segment and its `::`-joined tail
 * share the entry, so the last slug came back glued to the rest of the key and
 * never compared equal to itself. Recording the identity here instead of
 * re-deriving it from a formatted string is what makes that class of bug
 * impossible — the key is now free to grow segments without touching this.
 */
/**
 * The on-disk identity of one source's `permissions.json`, as a comparable
 * token. `'absent'` when there is no such file — which is a REAL state here, not
 * an error: a declared slug whose folder was deleted must not compare equal to
 * the same slug before the deletion.
 *
 * Inode is what makes delete-then-recreate detectable at all: a replaced file
 * can land in the same millisecond at the same size, and on APFS/ext4 it cannot
 * also reuse the inode of a file that was unlinked while this process still
 * held the old identity. Size and mtime are carried as well so an in-place
 * rewrite — which keeps the inode — is caught too.
 */
function sourcePermissionsStamp(workspaceRootPath: string, sourceSlug: string): string {
  try {
    const st = statSync(getSourcePermissionsPath(workspaceRootPath, sourceSlug));
    return `${st.ino}/${st.size}/${st.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

/**
 * One cache-key segment, length-prefixed so a concatenation of segments can only
 * be read one way.
 *
 * `String.prototype.length` counts UTF-16 code units and `slice` cuts by the
 * same unit, so the count and the cut agree for every input including astral
 * characters — the prefix is exact, not an approximation of "characters".
 */
function keySegment(value: string): string {
  return `${value.length}:${value}`;
}

/** An optional segment value, keeping "absent" distinct from the empty string. */
function keyOptional(value: string | undefined): string {
  return value === undefined ? '-' : `+${value}`;
}

/**
 * A slug list as one segment value: absent, or `+` and every slug
 * length-prefixed. Keeps `undefined`, `[]` and `['']` apart, and makes a comma
 * inside a slug ordinary text rather than a list separator.
 */
function keySlugList(slugs: readonly string[] | undefined): string {
  return slugs ? `+${slugs.map(keySegment).join('')}` : '-';
}

/** One parsed source config, with the file identity it was parsed from. */
interface CachedSourceConfig {
  readonly stamp: string;
  readonly config: PermissionsCustomConfig | null;
}

interface CachedMergedConfig {
  /** `context.workspaceRootPath`, compared by equality — never by prefix. */
  readonly workspaceRootPath: string;
  /**
   * The context's DECLARED `activeSourceSlugs`. Declared, not consumed: a
   * `pinnedConfigs` context never reads a source file (`buildMergedConfig`
   * returns at the end of that branch) yet still keys off these slugs, and
   * dropping such an entry on a source edit is harmless re-work, while missing
   * one is a stale policy.
   *
   * That re-work costs NOTHING today, and it is worth writing down so a later
   * reader does not budget for a cost that does not exist. The sole producer of
   * `pinnedConfigs` — `core/permission-manager.ts`'s
   * `setCapabilityPermissionLayers` — rebuilds the context from
   * `workspaceRootPath` alone and does not carry `activeSourceSlugs` forward at
   * all, so every pinned entry records the EMPTY set and `invalidateSource`
   * never matches one. No production site supplies both fields. The wording
   * above is about the day one does.
   */
  readonly sourceSlugs: ReadonlySet<string>;
  /**
   * The on-disk identity of every source `permissions.json` this merge actually
   * CONSUMED, checked again on every cache hit (P2.80).
   *
   * Why the entry validates itself instead of trusting a notification: nothing
   * invalidates on source DELETE or ADD. `deleteSource` is a bare `rmSync`,
   * `removeSourceEverywhere` never touches this cache, and the watcher routes a
   * source-DIRECTORY change to `handleSourcesDirChange`, which reloads the
   * source list and stops there. Measured before this field existed: delete a
   * source, add another that is handed the freed slug, and the new source was
   * policed by the DELETED one's permission file — a wrong policy applied to an
   * ordinary user action, not a staleness window.
   *
   * An eager `invalidateSource` is still the cheap path and still fires from the
   * watcher's file-level route; this map is what makes the answer correct when
   * nobody calls it. The cost is one `statSync` per DECLARED slug per cache hit
   * and is zero for the two shapes that dominate: a `pinnedConfigs` context
   * returns before any source file is read, and a context without
   * `activeSourceSlugs` has nothing to stamp. Both record an empty map.
   */
  readonly sourceStamps: ReadonlyMap<string, string>;
  readonly config: MergedPermissionsConfig;
}

declare const normalizedContextBrand: unique symbol;

/**
 * A {@link PermissionsContext} whose `activeSourceSlugs` are SORTED — the only
 * view `buildCacheKey` and `buildMergedConfig` accept (P2.78).
 *
 * The precondition used to be a sentence in a docblock: "the caller sorted for
 * me". That is the exact contract shape that had already decayed once here. The
 * in-place `.sort()` inside the key builder was silently load-bearing for the
 * MERGE, so replacing it with a sorted copy left the key normalizing and the
 * merge not — one cache entry holding two different merges, and an allow/deny
 * verdict that depended on declaration order. A comment cannot fail; this can.
 *
 * The brand is type-only, so it costs nothing at runtime and cannot be forged by
 * a cast that does not name it. {@link normalizePermissionsContext} is the sole
 * mint, and it sits three lines from the `.sort()` that earns it.
 */
export type NormalizedPermissionsContext = PermissionsContext & {
  readonly [normalizedContextBrand]: 'activeSourceSlugs-sorted';
};

/**
 * The ONE normalized view, handed to both the key and the merge.
 *
 * Sorts a COPY: `SessionManager.assertCdRulesPermit` passes
 * `managed.enabledSourceSlugs` straight in, so sorting in place would
 * permanently reorder a live session's own array.
 *
 * ## Why ALPHABETICAL is the tie-break, and not merely why the order is
 * normalized (P2.77)
 *
 * These two questions were conflated. The docblock on `getMergedConfig` below
 * answers the second at length — one `.sort()` on this path so the key and the
 * merge cannot disagree — and it names the one field whose verdict turns on
 * position: `toolRules`, read first-match-wins by
 * `mode-manager.ts:matchesToolPermissionRule`. So when two sources name one tool
 * with opposite actions, the slug SPELLING decides the verdict, and a source
 * called `a-foo` beats one called `z-foo`.
 *
 * Nothing said why. It is this: **lexicographic is the only ordering available
 * here that is stable and workspace-independent.** Every caller — the two agent
 * backends and `assertCdRulesPermit` — builds these slugs from SET-ITERATION
 * order, which is insertion order, which is when each source happened to
 * activate. Ordering by that would make an allow/deny flip depend on which
 * context asked first, differing per session inside one workspace and changing
 * when a user toggles a source off and on again. Alphabetical is arbitrary but
 * it is the same arbitrary answer every time, which is the property a permission
 * verdict needs.
 *
 * That is a justification for the CURRENT behaviour, not a claim that it is the
 * right product answer. The alternative the row offers — an ordering the user
 * can see and control — is a real improvement and an owner decision, because it
 * adds a user-visible concept (source precedence) to a surface that has none.
 * Recorded rather than taken.
 */
function normalizePermissionsContext(context: PermissionsContext): NormalizedPermissionsContext {
  const normalized = context.activeSourceSlugs
    ? { ...context, activeSourceSlugs: [...context.activeSourceSlugs].sort() }
    : context;
  return normalized as NormalizedPermissionsContext;
}

/**
 * In-memory cache for parsed permissions configs
 * Invalidated on file changes via ConfigWatcher
 */
class PermissionsConfigCache {
  private workspaceConfigs: Map<string, PermissionsCustomConfig | null> = new Map();
  /**
   * Parsed source configs, NESTED workspace → slug rather than keyed by a
   * `${root}::${slug}` string.
   *
   * The composite key was the same ambiguity P2.79 fixed in the merged key one
   * level up — workspace `/a` with slug `b::c` and workspace `/a::b` with slug
   * `c` compose one string — and it forced `invalidateWorkspace` to choose
   * between not clearing this map at all (which is what it did) and clearing it
   * by prefix, which is the key-parsing that P2.52 paid for. Nesting removes the
   * composite key instead of escaping it: dropping a workspace is one `delete`
   * on the outer map, and no slug can ever be read out of a formatted string.
   */
  private sourceConfigs: Map<string, Map<string, CachedSourceConfig>> = new Map();
  private mergedConfigs: Map<string, CachedMergedConfig> = new Map();

  // App-level default permissions (loaded from ~/.nessy-agent/permissions/default.json)
  private defaultConfig: PermissionsCustomConfig | null | undefined = undefined; // undefined = not loaded yet

  /**
   * Get or load app-level default permissions
   * These come from ~/.nessy-agent/permissions/default.json
   */
  private getDefaultConfig(): PermissionsCustomConfig | null {
    if (this.defaultConfig === undefined) {
      this.defaultConfig = loadDefaultPermissions();
    }
    return this.defaultConfig;
  }

  /**
   * Get or load workspace config
   */
  getWorkspaceConfig(workspaceRootPath: string): PermissionsCustomConfig | null {
    if (!this.workspaceConfigs.has(workspaceRootPath)) {
      this.workspaceConfigs.set(workspaceRootPath, loadWorkspacePermissionsConfig(workspaceRootPath));
    }
    return this.workspaceConfigs.get(workspaceRootPath) ?? null;
  }

  /**
   * Get or load source config
   */
  getSourceConfig(workspaceRootPath: string, sourceSlug: string): PermissionsCustomConfig | null {
    return this.getStampedSourceConfig(workspaceRootPath, sourceSlug).config;
  }

  /**
   * The parsed source config together with the file identity it came from,
   * re-reading whenever that identity moved.
   *
   * The re-read is what carries P2.80's live half: a source can be deleted and
   * another added under the same slug with nobody calling `invalidateSource`,
   * and a cache that only ever grew would answer from the deleted source's file
   * forever. Comparing the stamp costs one `statSync` on a path this method was
   * about to `existsSync` + `readFileSync` anyway when cold, so the guard is
   * free on a miss and one syscall on a hit.
   */
  private getStampedSourceConfig(workspaceRootPath: string, sourceSlug: string): CachedSourceConfig {
    let bySlug = this.sourceConfigs.get(workspaceRootPath);
    if (!bySlug) {
      bySlug = new Map();
      this.sourceConfigs.set(workspaceRootPath, bySlug);
    }
    const stamp = sourcePermissionsStamp(workspaceRootPath, sourceSlug);
    const cached = bySlug.get(sourceSlug);
    if (cached && cached.stamp === stamp) return cached;

    const entry: CachedSourceConfig = {
      stamp,
      config: loadSourcePermissionsConfig(workspaceRootPath, sourceSlug),
    };
    bySlug.set(sourceSlug, entry);
    return entry;
  }

  /**
   * Invalidate app-level default permissions (called by ConfigWatcher)
   * This clears all merged configs since defaults affect everything
   */
  invalidateDefaults(): void {
    debug('[Permissions] Invalidating app-level default permissions');
    this.defaultConfig = undefined;
    // Clear ALL merged configs since defaults affect everything
    this.mergedConfigs.clear();
  }

  /**
   * Invalidate workspace config (called by ConfigWatcher)
   */
  invalidateWorkspace(workspaceRootPath: string): void {
    debug(`[Permissions] Invalidating workspace config: ${workspaceRootPath}`);
    this.workspaceConfigs.delete(workspaceRootPath);
    // Drop this workspace's parsed SOURCE configs too (P2.80). Without this the
    // merged entries below were dropped and immediately rebuilt from the cached
    // source parses, so a recompute produced a byte-identical stale answer: it
    // looked invalidated, and nothing logged. One `delete` reaches every slug
    // because the map is nested rather than composite-keyed.
    this.sourceConfigs.delete(workspaceRootPath);
    // Clear all merged configs for this workspace. The workspace comes off the
    // recorded entry, not off the key text — see `CachedMergedConfig`.
    for (const [key, entry] of this.mergedConfigs) {
      if (entry.workspaceRootPath === workspaceRootPath) {
        this.mergedConfigs.delete(key);
      }
    }
  }

  /**
   * Invalidate source config (called by ConfigWatcher)
   *
   * Reaches EVERY merged config whose context declared this slug. The previous
   * version recovered the slug list by slicing and splitting the cache key, so
   * the last slug arrived carrying the whole `::rev::trust::…` tail: every slug
   * but the lexicographically last was invalidated, and a lone active source was
   * never invalidated at all — a `/cd` gate could answer from a policy the user
   * had already edited. Set membership cannot express that failure.
   */
  invalidateSource(workspaceRootPath: string, sourceSlug: string): void {
    debug(`[Permissions] Invalidating source config: ${workspaceRootPath}/${sourceSlug}`);
    this.sourceConfigs.get(workspaceRootPath)?.delete(sourceSlug);
    // Whole-slug membership, so "linear" still does not invalidate "linear-triage".
    for (const [key, entry] of this.mergedConfigs) {
      if (entry.workspaceRootPath !== workspaceRootPath) continue;
      if (entry.sourceSlugs.has(sourceSlug)) {
        this.mergedConfigs.delete(key);
      }
    }
  }


  /**
   * Get merged config for a context (workspace + active sources)
   * Uses additive merging: custom configs extend defaults
   */
  getMergedConfig(context: PermissionsContext): MergedPermissionsConfig {
    // ONE normalized view, handed to BOTH the key and the merge.
    //
    // The slug order is merge-relevant: `buildMergedConfig` iterates
    // `activeSourceSlugs` and every source it visits PUSHES onto `toolRules`,
    // `allowedTools`, `disallowedTools` and the permission-DSL layer list. Only
    // ONE of those four decides a verdict by position — `toolRules`, read
    // first-match-wins by `mode-manager.ts:matchesToolPermissionRule`, so two
    // sources naming one tool with opposite actions resolve by who is visited
    // first. The other three are position-sensitive in ATTRIBUTION only:
    // `allowedTools`/`disallowedTools` go through `matchesToolPattern`, whose
    // answer is boolean membership (order picks which pattern name lands in the
    // reason string), and DSL layers resolve by `ACTION_WEIGHT` then
    // `SCOPE_WEIGHT` then first-wins (`pi-harness/permission-dsl.ts:797-801`),
    // so between two `plugin`-scope layers a deny outranks an allow wherever it
    // sits. All four are normalized regardless: the verdict-deciding one demands
    // it, and a reason string that names a different rule per session is its own
    // bug — but do not read this as four independent verdict flips.
    //
    // The key has always normalized that order, so both orders share one entry.
    // While the key's `.sort()` ran IN PLACE it also normalized the array the
    // merge went on to read, and the two agreed by accident. Fixing the caller-
    // array mutation by sorting a COPY kept the key's normalization and dropped
    // the merge's: one entry, two merges, and an allow/deny flip decided by
    // whichever context asked first. `assertCdRulesPermit`, `pi-agent` and
    // `codex-agent` all build these slugs from set-iteration order, so that is
    // per-session inside one workspace.
    //
    // Normalizing HERE — once, before either consumer — is what makes the
    // agreement structural instead of accidental: there is exactly one `.sort()`
    // on this path, the caller's own array is never touched, and a future reader
    // of the slug order inside either function inherits the same view.
    const normalized = normalizePermissionsContext(context);
    const cacheKey = this.buildCacheKey(normalized);

    const cached = this.mergedConfigs.get(cacheKey);
    // A hit is only a hit while the files it was built from are the same files.
    // See `CachedMergedConfig.sourceStamps` for why the entry checks itself
    // rather than waiting to be told (P2.80).
    if (cached && this.sourceStampsStillMatch(cached)) return cached.config;
    if (cached) this.mergedConfigs.delete(cacheKey);

    const sourceStamps = new Map<string, string>();
    const config = this.buildMergedConfig(normalized, sourceStamps);
    this.mergedConfigs.set(cacheKey, {
      workspaceRootPath: normalized.workspaceRootPath,
      sourceSlugs: new Set(normalized.activeSourceSlugs ?? []),
      sourceStamps,
      config,
    });
    return config;
  }

  /** Every source file this entry consumed is still the same file. */
  private sourceStampsStillMatch(entry: CachedMergedConfig): boolean {
    for (const [sourceSlug, stamp] of entry.sourceStamps) {
      if (sourcePermissionsStamp(entry.workspaceRootPath, sourceSlug) !== stamp) {
        debug(
          `[Permissions] Source permissions file changed identity, rebuilding merged config: `
          + `${entry.workspaceRootPath}/${sourceSlug}`,
        );
        return false;
      }
    }
    return true;
  }

  /**
   * @param sourceStamps filled with the on-disk identity of every source
   * `permissions.json` this merge CONSUMES. It is written at the one place a
   * source file is read, so it cannot drift out of step with which branch did
   * the reading — the `pinnedConfigs` branch returns before the slug loop and
   * therefore leaves it empty, and that stays true without anyone maintaining a
   * second copy of that fact.
   */
  private buildMergedConfig(
    context: NormalizedPermissionsContext,
    sourceStamps: Map<string, string>,
  ): MergedPermissionsConfig {
    const defaults = SAFE_MODE_CONFIG;

    // Start with hardcoded fallback defaults (blocked-tool floor, display settings).
    // The four blocked tools (Write, Edit, MultiEdit, NotebookEdit) come from
    // SAFE_MODE_CONFIG and are the FLOOR: the appliers below only ever `add` to
    // this set, so a layer's `blockedTools` extends it and no layer — however
    // short its list — can take one of the four back out.
    const merged: MergedPermissionsConfig = {
      blockedTools: new Set(defaults.blockedTools),
      readOnlyBashPatterns: [...defaults.readOnlyBashPatterns],
      blockedCommandHints: [...(defaults.blockedCommandHints ?? [])],
      readOnlyMcpPatterns: [...defaults.readOnlyMcpPatterns],
      allowedApiEndpoints: [],
      allowedWritePaths: [],
      deniedPaths: [...(defaults.deniedPaths ?? [])],
      deniedToolPatterns: [...(defaults.deniedToolPatterns ?? [])],
      allowedTools: [...(defaults.allowedTools ?? [])],
      disallowedTools: [...(defaults.disallowedTools ?? [])],
      toolRules: [...(defaults.toolRules ?? [])],
      displayName: defaults.displayName,
      shortcutHint: defaults.shortcutHint,
      // Add permission file paths for actionable error messages
      permissionPaths: {
        workspacePath: getWorkspacePermissionsPath(context.workspaceRootPath),
        appDefaultPath: join(getAppPermissionsDir(), 'default.json'),
        docsPath: join(CONFIG_DIR, 'docs', 'permissions.md'),
      },
    };
    const permissionDslLayers: PermissionDslLayerInputV1[] = [];
    if (context.managedPermissionDsl) {
      const document = structuredClone(context.managedPermissionDsl);
      // D3, the other half. A managed policy is DELIVERED — the remote channel
      // hands over a document, not a file — so there is no settings directory
      // for a `/`-anchored rule to resolve against, and inventing one would
      // silently point an administrator's rule at a directory they never named.
      // The rule is dropped PER RULE and said out loud, rather than left to
      // throw at compile: the compiler catches per LAYER, so one unresolvable
      // anchor in a delivered policy would take every OTHER managed rule down
      // with it — the loudest possible failure and the least safe one.
      const anchored = document.rules.filter(rule => rule.match.anchor === 'source');
      for (const rule of anchored) {
        debug(
          `[Permissions] Managed policy rule "${rule.id}" is anchored at its settings source, but a `
          + 'delivered managed policy has no file to anchor to, so it cannot be enforced and is dropped. '
          + 'Use the `//` (absolute) or `~/` (home) anchor instead.',
        );
      }
      const rules = anchored.length === 0
        ? document.rules
        : document.rules.filter(rule => rule.match.anchor !== 'source');
      permissionDslLayers.push({
        scope: 'managed',
        sourceDigest: managedPermissionDslDigest(context.managedPermissionDsl),
        document: { ...document, rules, generation: context.pinnedRevision ?? 'live' },
      });
    }
    // `settings-reference.md#allowmanagedpermissionrulesonly`. The filter sits
    // in the one function every
    // settings-derived layer goes through, so a new layer source added later is
    // covered by construction rather than by remembering to gate it. `managed`
    // is spelled out rather than assumed absent here because a capability layer
    // can declare `builtin`, which `PermissionManager` maps to `managed`.
    const managedRulesOnly = context.managedPermissionRulesOnly === true;
    const inertRuleDiagnostics: PermissionPolicyDiagnosticV1[] = [];
    const addPermissionDsl = (config: PermissionsCustomConfig, scope: PermissionDslScope) => {
      if (managedRulesOnly && scope !== 'managed') return;
      // P6.676 — the ALLOW-only inert forms, joined to the scope HERE because
      // this is the only place that knows which settings tier the document came
      // from, exactly as `reportPermissionDslDiagnostics` joins the compiler's.
      // Read before the `permissionDsl` guard below: a document can carry an
      // inert allow rule and no installable rule at all, and that is precisely
      // the case where the user has been told nothing.
      for (const code of config.inertPermissionRuleCodes ?? []) {
        inertRuleDiagnostics.push(Object.freeze({ code, scope }));
      }
      if (!config.permissionDsl) return;
      // D3 — the seam `permission-dsl` has always accepted. Threading it here
      // is what turns the documented `/`-anchored rule from silently inert into
      // enforced; `parsePermissionsJson` already refused to emit one without it.
      permissionDslLayers.push({
        ...config.permissionDsl,
        scope,
        ...(config.sourceRoot === undefined ? {} : { sourceRoot: config.sourceRoot }),
      });
    };
    /**
     * D2 — the same lock, applied to the OTHER three appliers.
     *
     * `addPermissionDsl` above covers the readable rules
     * `settings-reference.md#allowmanagedpermissionrulesonly` names literally. The `permissions.json` fields below are our own
     * extension surface and are not "permission rules" in that sentence's
     * sense, so the lock's shape for them is taken from the three SIBLING
     * managed-only locks, which all carve the deny half out in so many words
     * (`permissions.md`, "Managed-only settings"): `allowManagedMcpServersOnly`
     * — "`deniedMcpServers` still merges from all sources";
     * `sandbox.filesystem.allowManagedReadPathsOnly` — "`denyRead` still merges
     * from all sources"; `sandbox.network.allowManagedDomainsOnly` — "Denied
     * domains still merge from all sources".
     *
     * So the lock drops ALLOW-DIRECTION contributions from non-managed scopes
     * and nothing else. A layer that carries both directions is filtered field
     * by field, and `toolRules` entry by entry on its own `action`.
     *
     * The `global` scope is the app's own `permissions/default.json`, and it
     * keeps its READ-ONLY CLASSIFICATION (`allowedBashPatterns`,
     * `allowedMcpPatterns` — 196 and 15 patterns in the shipped file) because
     * that is what makes `ls` and `git status` read-only at all. Dropping it
     * would make `safe`, `plan` and `auto` prompt for every command; an
     * administrator would then turn the lock off, which is strictly less safe
     * than not having it. Its GRANT fields still drop: the shipped file carries
     * none of them, so this costs nothing and closes the widening path a user
     * who edits that file would otherwise keep.
     */
    const grantsAllowed = (scope: PermissionDslScope) => !managedRulesOnly || scope === 'managed';
    const readOnlyClassificationAllowed = (scope: PermissionDslScope) =>
      !managedRulesOnly || scope === 'managed' || scope === 'global';
    /** The layer as the lock lets it contribute. Deny-direction fields untouched. */
    const underLock = (
      config: PermissionsCustomConfig,
      scope: PermissionDslScope,
    ): PermissionsCustomConfig => {
      if (!managedRulesOnly || scope === 'managed') return config;
      return {
        ...config,
        ...(readOnlyClassificationAllowed(scope)
          ? {}
          : { allowedBashPatterns: [], allowedMcpPatterns: [] }),
        ...(grantsAllowed(scope)
          ? {}
          : {
            allowedApiEndpoints: [],
            allowedWritePaths: [],
            allowedTools: [],
            toolRules: config.toolRules.filter(rule => rule.action !== 'allow'),
          }),
      };
    };
    const finalizePermissionDsl = () => {
      // Session rules ride LAST, as their own layer, so they are never mixed
      // into a capability layer's digest and survive a generation change.
      if (context.sessionRules && context.sessionRules.length > 0) {
        permissionDslLayers.push({
          scope: 'workspace',
          sourceDigest: sessionRulesDigest(context.sessionRules),
          document: {
            version: 1,
            rules: context.sessionRules.map((rule, index) => ({
              id: `session-${index}`,
              action: rule.action,
              match: rule.match,
              // P2.445 — `raw` is the rule string this layer already carries so
              // `removeRules`/`replaceRules` can match on it; a refusal naming
              // `session-1` names nothing, and naming the raw costs one field.
              text: rule.raw,
            })),
          },
        });
      }
      if (permissionDslLayers.length === 0) {
        // P6.676 — an inert ALLOW rule is the one thing that can be present
        // with no layer behind it (a document whose only rules are inert
        // installs nothing), and it is exactly the case the user has never
        // been told about. Announce it before the early return.
        if (inertRuleDiagnostics.length > 0) {
          merged.permissionDslDiagnostics = Object.freeze([...inertRuleDiagnostics]);
        }
        return;
      }
      merged.permissionDsl = compilePermissionDslV1({
        generation: context.pinnedRevision ?? 'live',
        projectTrusted: context.projectTrusted === true,
        layers: permissionDslLayers,
        canonicalizeRoot: canonicalizeForDecision,
      });
      // The compile-time half of "skipped with a warning". Without this line the
      // diagnostics the compiler produces have no consumer at all.
      //
      // P2.276: the same call now also yields the host-safe carrier. It is only
      // set when there is something to say, so a config with a clean policy
      // carries no field at all and no consumer has to distinguish "none" from
      // "not computed".
      const safeDiagnostics = reportPermissionDslDiagnostics(merged.permissionDsl);
      const allDiagnostics = inertRuleDiagnostics.length === 0
        ? safeDiagnostics
        : Object.freeze([...safeDiagnostics, ...inertRuleDiagnostics]);
      if (allDiagnostics.length > 0) merged.permissionDslDiagnostics = allDiagnostics;
    };

    if (context.pinnedConfigs) {
      for (const layer of context.pinnedConfigs) {
        // The layer's own scope IS its provenance — the same value
        // `addPermissionDsl` has always keyed the lock off, so the four
        // appliers can never disagree about where a contribution came from.
        const scope = layer.scope ?? (layer.sourceSlug ? 'plugin' : 'workspace');
        // F1.715 — a source file restricts, and grants only for its own tools ({@link sourceConfigOwnToolsOnly}).
        const layerConfig = layer.sourceSlug ? sourceConfigOwnToolsOnly(layer.config, layer.sourceSlug) : layer.config;
        addPermissionDsl(layerConfig, scope);
        const config = underLock(layerConfig, scope);
        if (layer.sourceSlug) {
          this.applySourceConfig(merged, config, layer.sourceSlug);
        } else {
          this.applyCustomConfig(merged, config, scope); // F1.1057 — the scope tells the shipped floor's own file apart
        }
      }
      finalizePermissionDsl();
      return merged;
    }

    // Load and apply app-level default permissions from JSON
    // This is where the actual bash/MCP patterns come from
    const defaultConfig = this.getDefaultConfig();
    if (defaultConfig) {
      addPermissionDsl(defaultConfig, 'global');
      this.applyDefaultConfig(merged, underLock(defaultConfig, 'global'));
    }

    // Add workspace-level customizations
    const wsConfig = this.getWorkspaceConfig(context.workspaceRootPath);
    if (wsConfig) {
      addPermissionDsl(wsConfig, 'workspace');
      this.applyCustomConfig(merged, underLock(wsConfig, 'workspace'));
    }

    // Add source-level customizations (additive, with auto-scoped MCP patterns).
    //
    // THIS ITERATION ORDER IS A POLICY DECISION, not an implementation detail:
    // each visit appends to `toolRules` and to `permissionDslLayers`, and both
    // are resolved first-match-wins, so two sources that name the same tool with
    // opposite actions resolve by whoever is visited first. The order is
    // lexicographic because `getMergedConfig` sorted the slugs before calling —
    // do not iterate `context.activeSourceSlugs` from anywhere that has not.
    //
    // P2.203 — AND ONLY THE ENTRIES THAT CAN NAME A SOURCE ARE VISITED.
    //
    // `activeSourceSlugs` reaches here from `managed.enabledSourceSlugs`, which
    // is a bare `z.array(z.string())` on the way in with no per-entry check
    // anywhere: the `spawn_session` tool the MODEL fills in, the create-session
    // DTO, the workspace defaults a stored session replays. Each entry is then
    // used as a path segment. Measured on HEAD, with `['real']` and `[]` as
    // controls in the same run, `['../..', tmp]` made this loop read a
    // `permissions.json` from outside the workspace and merge its
    // `allowedBashPatterns` into `readOnlyBashPatterns` — source configs are
    // ADDITIVE, so a slug the model chose could only ever WIDEN the policy.
    //
    // `partitionSourceSlugs` is the one shared definition, not a second guard
    // written by hand next to `SourceManager`'s: that class closes the SIX
    // agent-side producers, and nothing it does is reachable from this list.
    //
    // The CACHE KEY still keys off the DECLARED list, deliberately. Keying off
    // the accepted list would merge `['']` onto `[]` and `['a','a']` onto
    // `['a']`, which is P2.79's injectivity property (`dbfb36347`) — a separate
    // decision, already made, and not this row's to reopen. Keying finer than
    // the merge needs costs one extra entry for a list nobody should be sending
    // and can never produce a wrong answer, which is the same trade
    // `CachedMergedConfig.sourceSlugs` already documents.
    if (context.activeSourceSlugs) {
      const { accepted, rejected } = partitionSourceSlugs(context.activeSourceSlugs);
      if (rejected.length > 0) {
        merged.unusableSourceSlugReasons = rejected.map(entry => entry.reason);
        for (const { index, reason } of rejected) {
          // The raw value stops here: the carrier above is the reason alone.
          // `index` is into the SORTED copy this function was handed, which is
          // the array being indexed on the next line — true here, and the reason
          // the carrier does not repeat it.
          debug(
            `[Permissions] Ignoring source slug #${index} (${reason}): `
            + JSON.stringify(context.activeSourceSlugs[index]),
          );
        }
      }
      for (const sourceSlug of accepted) {
        const stamped = this.getStampedSourceConfig(context.workspaceRootPath, sourceSlug);
        // Recorded for EVERY slug this loop visits, including one whose file is
        // absent: "this slug had no permissions.json" is exactly the state a
        // later `add` has to be able to differ from. A REFUSED slug is not
        // stamped, and must not be — a stamp is a promise this merge read that
        // path, and re-checking it on every hit is the one cost this row removes
        // rather than adds.
        sourceStamps.set(sourceSlug, stamped.stamp);
        // F1.715 — a source file restricts, and grants only for its own tools ({@link sourceConfigOwnToolsOnly}).
        const srcConfig = stamped.config && sourceConfigOwnToolsOnly(stamped.config, sourceSlug);
        if (srcConfig) {
          addPermissionDsl(srcConfig, 'plugin');
          // Use applySourceConfig which auto-scopes MCP patterns to this source
          this.applySourceConfig(merged, underLock(srcConfig, 'plugin'), sourceSlug);
        }
      }
    }

    finalizePermissionDsl();

    return merged;
  }

  /**
   * Apply app-level default config (from default.json)
   * This adds bash/MCP patterns from the JSON config, plus any `blockedTools`
   * the file declares on top of SAFE_MODE_CONFIG's hardcoded four.
   */
  private applyDefaultConfig(merged: MergedPermissionsConfig, config: PermissionsCustomConfig): void {
    // Add allowed bash patterns (as CompiledBashPattern with metadata for error messages)
    for (const patternEntry of config.allowedBashPatterns) {
      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          comment: patternEntry.comment,
        });
      } else {
        debug(`[Permissions] Invalid default bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // Add allowed MCP patterns
    for (const pattern of config.allowedMcpPatterns) {
      const regex = validateRegex(pattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
      } else {
        debug(`[Permissions] Invalid default MCP pattern, skipping: ${pattern}`);
      }
    }

    // Add allowed API endpoints
    for (const rule of config.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      }
    }

    // Add allowed write paths
    for (const pattern of config.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // Add denied paths
    for (const pattern of config.deniedPaths) {
      addDeniedPath(merged, pattern); addDeniedPathBeyondShippedFloor(merged, pattern, 'global'); // F1.1057
    }

    // Add denied tool patterns
    for (const pattern of config.deniedToolPatterns) {
      addDeniedToolPattern(merged, pattern);
    }

    // Add blocked tools (additive on top of the hardcoded four)
    for (const toolName of config.blockedTools) {
      merged.blockedTools.add(toolName);
    }

    merged.allowedTools.push(...config.allowedTools);
    merged.disallowedTools.push(...config.disallowedTools);

    for (const rule of config.toolRules) {
      merged.toolRules.push(rule);
    }

    // Add blocked command hints (contextual guidance for blocked bash commands)
    for (const hint of config.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  private applyCustomConfig(merged: MergedPermissionsConfig, custom: PermissionsCustomConfig, scope?: PermissionDslScope): void {
    // Add allowed bash patterns (making config more permissive)
    for (const patternEntry of custom.allowedBashPatterns) {
      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          comment: patternEntry.comment,
        });
      } else {
        debug(`[Permissions] Invalid bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // Add allowed MCP patterns
    for (const pattern of custom.allowedMcpPatterns) {
      const regex = validateRegex(pattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
      } else {
        debug(`[Permissions] Invalid MCP pattern, skipping: ${pattern}`);
      }
    }

    // Add allowed API endpoints (fine-grained)
    for (const rule of custom.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      } else {
        debug(`[Permissions] Invalid API endpoint path pattern, skipping: ${rule.path}`);
      }
    }

    // Add allowed write paths (glob patterns, stored as strings)
    for (const pattern of custom.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // Add denied paths (additive; custom configs can only make the deny surface stricter)
    for (const pattern of custom.deniedPaths) {
      addDeniedPath(merged, pattern); addDeniedPathBeyondShippedFloor(merged, pattern, scope); // F1.1057
    }

    // Add denied tool patterns (additive; custom configs can only make the deny surface stricter)
    for (const pattern of custom.deniedToolPatterns) {
      addDeniedToolPattern(merged, pattern);
    }

    // Add blocked tools (additive, same direction: the hardcoded four stay in)
    for (const toolName of custom.blockedTools) {
      merged.blockedTools.add(toolName);
    }

    merged.allowedTools.push(...custom.allowedTools);
    merged.disallowedTools.push(...custom.disallowedTools);

    for (const rule of custom.toolRules) {
      merged.toolRules.push(rule);
    }

    // Add blocked command hints
    for (const hint of custom.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  /**
   * Apply source-specific config with auto-scoped MCP patterns.
   * MCP patterns in a source's permissions.json are automatically prefixed with
   * mcp__<sourceSlug>__ so they only apply to that source's tools.
   * This prevents cross-source leakage when using simple patterns like "list".
   */
  private applySourceConfig(
    merged: MergedPermissionsConfig,
    custom: PermissionsCustomConfig,
    sourceSlug: string
  ): void {
    // Write paths - global effect; empty for a source file since F1.715 (`sourceConfigOwnToolsOnly`)
    for (const pattern of custom.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // Denied paths - apply normally (global effect)
    for (const pattern of custom.deniedPaths) {
      addDeniedPath(merged, pattern); addDeniedPathBeyondShippedFloor(merged, pattern, 'plugin'); // F1.1057
    }

    // Denied tool patterns - apply normally (global effect)
    for (const pattern of custom.deniedToolPatterns) {
      addDeniedToolPattern(merged, pattern);
    }

    // Blocked tools - apply normally (global effect, like the deny fields above).
    // NOT auto-scoped the way this source's MCP patterns are: scoping widens an
    // ALLOW so it cannot leak across sources, and there is nothing to protect in
    // widening a deny - a source that names a tool means that tool.
    for (const toolName of custom.blockedTools) {
      merged.blockedTools.add(toolName);
    }

    merged.allowedTools.push(...custom.allowedTools);
    merged.disallowedTools.push(...custom.disallowedTools);

    for (const rule of custom.toolRules) {
      merged.toolRules.push(rule);
    }

    // MCP patterns - AUTO-SCOPE to this source, anchored to the tool's LEADING verb
    // User writes: "list" → becomes: "^mcp__<sourceSlug>__(?:list)(?:_<word>)*$" (F1.287)
    // This ensures patterns only match tools from THIS source, led by the verb
    for (const pattern of custom.allowedMcpPatterns) {
      const scopedPattern = scopeSourceMcpPattern(sourceSlug, pattern);
      const regex = validateRegex(scopedPattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
        debug(`[Permissions] Scoped MCP pattern for ${sourceSlug}: ${pattern} → ${scopedPattern}`);
      } else {
        debug(`[Permissions] Invalid MCP pattern after scoping, skipping: ${scopedPattern}`);
      }
    }

    // Bash patterns - not source-specific; empty for a source file since F1.715 (`sourceConfigOwnToolsOnly`)
    for (const patternEntry of custom.allowedBashPatterns) {
      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          comment: patternEntry.comment,
        });
      } else {
        debug(`[Permissions] Invalid bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // API endpoints - F1.1152: scoped to this source's own API tool, api_<slug> (`apiEndpointRuleGrantsTool`); they were global
    for (const rule of custom.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex, sourceSlug,
        });
      } else {
        debug(`[Permissions] Invalid API endpoint path pattern, skipping: ${rule.path}`);
      }
    }

    // Blocked command hints - apply normally (bash is session-level)
    for (const hint of custom.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  /**
   * The merged-config cache key.
   *
   * THE INVARIANT IS INJECTIVITY, not "the separator is escaped". Two contexts
   * hit the same entry if and only if they compose the same merged config. A key
   * that two DIFFERENT contexts can produce is not a stale read — it is a
   * permissions verdict decided by cache arrival order, which is what P2.79
   * measured on the previous `::`-joined form: `['a,b']` and `['a','b']` in one
   * workspace shared an entry, and `shouldAllowToolInMode('FooTool', …,
   * 'dontAsk')` answered `false` or `true` on the same fixture purely according
   * to which context asked first. The cross-workspace twin was worse — `W=<b>/w`
   * with `['a::b']` and `W=<b>/w::a` with `['b']` composed one string, so the
   * second workspace was served the first one's merge INCLUDING its
   * `permissionPaths`, and could not invalidate its own entry.
   *
   * GRAMMAR: every segment is emitted as `<length>:<value>`, and the key is
   * their bare concatenation. That encoding is prefix-free — reading left to
   * right, the decimal digits before the first `:` give the exact number of
   * UTF-16 code units that follow — so the segment sequence is recoverable from
   * the key, which is precisely what makes it impossible for two different
   * sequences to collide. Escaping would also have worked; length-prefixing was
   * chosen because its injectivity is one sentence rather than a case analysis
   * over which characters were escaped in which order, and because it needs no
   * separator at all, so there is nothing left for a reader to split ON.
   *
   * Nothing may PARSE it back. "Recoverable in principle" is what makes the key
   * sound; a reader that actually decodes it re-creates the positional bug P2.52
   * paid for. Facts a caller needs about the cached context — its workspace, its
   * source slugs, the files it consumed — are recorded on the entry itself
   * (`CachedMergedConfig`), so a new segment may be appended here freely and no
   * invalidator has to change.
   *
   * ARITY IS PART OF THE VALUE. `undefined`, `[]` and `['']` are three different
   * slug declarations and must be three different keys: the old `join(',')`
   * flattened all three to `''`, while the MERGE read `['']` as one slug and
   * loaded `<root>/sources/permissions.json` — so an authored empty slug
   * enforced a rule under an identity that claimed no slugs were declared at
   * all. `-` for absent versus `+` followed by length-prefixed elements keeps
   * the three apart by construction.
   *
   * Every `PermissionsContext` field must be covered by some segment — an
   * uncovered field means two different contexts share one merged config. Field
   * ORDER counts as part of a field: `activeSourceSlugs` order decides the merge
   * (see `getMergedConfig`), so it is only key-invisible because the caller
   * hands both this and `buildMergedConfig` the SAME already-sorted view.
   *
   * PRECONDITION, now ENFORCED rather than described (P2.78): the parameter is
   * {@link NormalizedPermissionsContext}, which only
   * {@link normalizePermissionsContext} mints. This builder does not sort — a
   * second `.sort()` here would be a second normalization to keep in step with
   * the merge's, which is exactly the agreement that broke last time.
   */
  private buildCacheKey(context: NormalizedPermissionsContext): string {
    const managedDigest = context.managedPermissionDsl
      ? managedPermissionDslDigest(context.managedPermissionDsl)
      : '';
    const sessionDigest = context.sessionRules && context.sessionRules.length > 0
      ? sessionRulesDigest(context.sessionRules)
      : '';
    // The lock is part of the key: two contexts that differ only by it compose
    // different rule sets, and serving one from the other's cache entry would
    // apply a user rule under an engaged lock.
    const rulesOnly = context.managedPermissionRulesOnly === true ? 'managed-only' : 'all-scopes';
    // The pinned LAYERS are keyed by their content, not by the revision that
    // names them. The revision alone was not enough on either side:
    //   - two contexts sharing a `pinnedRevision` but carrying different layers
    //     were served one merged config;
    //   - with NO revision the `?? ''` above collapses that segment, so every
    //     pinned-config context on one workspace collided.
    // This comment used to read "Only ONE producer builds this context today
    // (`core/permission-manager.ts:setCapabilityPermissionLayers`)". That is
    // false as written — several sites build a `PermissionsContext` inline,
    // including `SessionManager.assertCdRulesPermit`. What is true, and what the
    // argument actually rests on, is that only one producer supplies
    // `pinnedConfigs`, and it always passes a generation string; that is the
    // sole reason neither half ever bit in production. It is an accident of the
    // current caller, not a property of the cache — do not remove this digest on
    // the strength of it.
    //
    // `canonicalJson` (not `JSON.stringify`) is what keeps the key STABLE: it
    // sorts object keys at every level, so two structurally equal layers built
    // by different code paths hash the same and still HIT. Insertion-order
    // serialization would miss forever and turn the cache into a leak. Array
    // order is deliberately preserved — layer order decides which layer wins.
    // The digest is a sha256 hex, never `''`, so "no pinned layers at all" stays
    // distinguishable from an empty list, which takes a different merge branch.
    //
    // The hash itself is memoized by array identity for a FROZEN array only —
    // see {@link pinnedConfigsDigest}, which carries the measurement showing
    // that this line, not the merge, was the cost of a warm hit.
    const pinnedDigest = context.pinnedConfigs
      ? pinnedConfigsDigest(context.pinnedConfigs)
      : '';
    return [
      context.workspaceRootPath,
      keySlugList(context.activeSourceSlugs),
      keyOptional(context.pinnedRevision),
      context.projectTrusted === true ? 'trusted' : 'untrusted',
      managedDigest,
      sessionDigest,
      rulesOnly,
      pinnedDigest,
    ].map(keySegment).join('');
  }

  /**
   * Clear all cached configs
   */
  clear(): void {
    this.defaultConfig = undefined;
    this.workspaceConfigs.clear();
    this.sourceConfigs.clear();
    this.mergedConfigs.clear();
  }
}

// Singleton instance
export const permissionsConfigCache = new PermissionsConfigCache();

// ============================================================
// Retired shipped patterns (F1.258)
// ============================================================

/**
 * Shipped allow-list strings a later bundle RETIRED, keyed by the bundle version
 * that retired them.
 *
 * `migratePermissions` only ever APPENDS the bundle's new patterns — it never
 * removes one — so a TIGHTENED shipped pattern could not reach an installed
 * `default.json`: the old string stayed beside its successor and kept admitting
 * everything the successor refuses (an allow-list is a union, so one loose entry
 * is the whole verdict). F1.258 (origin WJ-w P-WJ-w-3, 2026-09-23) measured it on
 * the read-only MCP list: the fifteen strings below were unanchored substrings of
 * the whole tool name, so `mcp__acme__update_issue_status` (`status`),
 * `delete_account` (`count`), `execute_query` (`query`) and five more write-named
 * tools ran with no card in Explore, `default` and `dontAsk`. The bundle now ships
 * each verb anchored to the START of the tool segment; this table is what takes
 * the old strings out of a file installed before that.
 *
 * The rule, and its stated residue:
 * - Applied only while CROSSING `version` (installed older, bundle at or past
 *   it), so a file already migrated is never touched again — a user who re-adds
 *   one of these strings afterwards keeps it.
 * - EXACT match on the pattern string. A user entry spelled identically to a
 *   retired shipped string cannot be told apart from it and is retired too; one
 *   line per retired string names it on stderr and in `<config dir>/logs/boot.log`
 *   ({@link reportShippedPatternRetirement}, always on since F1.293 — it used to be
 *   the NESSY_DEBUG-gated debug stream, which a packaged build never writes), so
 *   the removal is legible after the fact. Every other entry — the user's own — is
 *   left byte for byte.
 * - The successors are not listed here: they are the bundle's own current
 *   patterns, and the unchanged merge after this step appends the ones missing.
 *
 * The strings are HISTORY and never change: the `allowedMcpPatterns` block was
 * identical in every bundle from the seed through `2026-09-06` (read from the
 * file at each commit that touched it; `shipped-mcp-read-only-anchoring.test.ts`
 * carries the list with its comments).
 */
export const RETIRED_SHIPPED_PATTERNS: ReadonlyArray<{
  readonly version: string;
  readonly field: 'allowedMcpPatterns' | 'allowedBashPatterns' | 'blockedCommandHints';
  readonly label: string;
  readonly patterns: readonly string[];
}> = [
  {
    version: '2026-09-23',
    field: 'allowedMcpPatterns',
    label: 'unanchored MCP pattern',
    patterns: [
      'search', 'list', 'get', 'read', 'info', 'describe', 'show', 'view',
      'find', 'query', 'count', 'exists', 'status', 'inspect', 'fetch',
    ],
  },
  // F1.258 follow-up — the same hole on the bash list. Every string any bundle
  // shipped that the current one does not: the union over the eleven commits
  // that touched the file (aadf3a052 … e6296c0f7) minus HEAD. The 19 P2.207
  // predecessors (`64c6a8391` anchored them after measuring 56 holes —
  // `python -c import os --help`, `sed -n -i`, `git branch -D main` — without
  // moving `version`, so the `2026-08-28` bump APPENDED the fixes to every older
  // install and kept the holes), the ten dead `nessy-general-agent` CLI entries
  // 2ea932a19 removed, and the ten pre-rebrand `craft-agent` spellings of them.
  // `shipped-bash-retirement-migration.test.ts` holds the independent copy.
  // F1.290 — keyed to `2026-09-23.2`, not the `2026-09-23` it was added under:
  // that bundle had already shipped (`f4a545cca`) WITHOUT this entry, so a profile
  // migrated by a build between the two sat at `2026-09-23` and never crossed it.
  // A retirement is keyed to a bundle version no earlier build carried
  // (`bundle-version-retirement-crossing.test.ts`; F1.291 pins the rule).
  {
    version: '2026-09-23.2',
    field: 'allowedBashPatterns',
    label: 'bash pattern',
    patterns: [
      '^craft-agent\\s+label\\s+(list|get|auto-rule-list|auto-rule-validate)\\b',
      '^craft-agent\\s+source\\s+(list|get|validate|test|auth-help)\\b',
      '^craft-agent\\s+skill\\s+(list|get|validate|where)\\b',
      '^craft-agent\\s+automation\\s+(list|get|validate|history|last-executed|test|lint)\\b',
      '^craft-agent\\s+permission\\s+(list|get|validate)\\b',
      '^craft-agent\\s+theme\\s+(get|validate|list-presets|get-preset)\\b',
      '^craft-agent\\s*$',
      '^craft-agent\\s+(label|source|skill|automation|permission|theme)\\s*$',
      '^craft-agent\\s+(label|source|skill|automation|permission|theme)\\s+--help\\b',
      '^craft-agent\\s+--(help|version|discover)\\b',
      '^fd\\b',
      '^git\\s+((-[A-Za-z]|--[a-z][-a-z]*)(\\s+[^\\s-][^\\s]*)?\\s+)*(status|log|diff|show|branch|tag|remote|stash\\s+list|describe|rev-parse|config\\s+--get|config\\s+-l|ls-files|ls-tree|shortlog|blame|annotate|reflog|cherry|whatchanged|ls-remote|history)\\b',
      '^gh\\s+api\\b.*--method\\s+GET\\b',
      '^gh\\s+api\\b(?!.*--method)',
      '^npm\\s+(ls|list|view|info|show|outdated|audit|search|explain|why|config\\s+get|config\\s+list)\\b',
      '^pnpm\\s+(list|ls|why|outdated|audit)\\b',
      '^kubectl\\s+(get|describe|logs|top|explain|api-resources|api-versions|cluster-info|config\\s+view|config\\s+get-contexts|version)\\b',
      '^sed\\s+-n\\b',
      '^sort\\b',
      '^uniq\\b',
      '^yq\\b',
      '^xq\\b',
      '^xmllint\\b',
      '^python\\s+-m\\s+json\\.tool\\b',
      '^ss\\b',
      '^ip\\s+(addr|link|route|neigh)\\s*(show)?\\b',
      '^ifconfig\\b',
      '--help\\b',
      '-h\\b$',
      '^nessy-general-agent\\s+label\\s+(list|get|auto-rule-list|auto-rule-validate)\\b',
      '^nessy-general-agent\\s+source\\s+(list|get|validate|test|auth-help)\\b',
      '^nessy-general-agent\\s+skill\\s+(list|get|validate|where)\\b',
      '^nessy-general-agent\\s+automation\\s+(list|get|validate|history|last-executed|test|lint)\\b',
      '^nessy-general-agent\\s+permission\\s+(list|get|validate)\\b',
      '^nessy-general-agent\\s+theme\\s+(get|validate|list-presets|get-preset)\\b',
      '^nessy-general-agent\\s*$',
      '^nessy-general-agent\\s+(label|source|skill|automation|permission|theme)\\s*$',
      '^nessy-general-agent\\s+(label|source|skill|automation|permission|theme)\\s+--help\\b',
      '^nessy-general-agent\\s+--(help|version|discover)\\b',
    ],
  },
  // F1.292 — four READ verbs that printed a credential the path floor denies to
  // a read (`~/.kube/`, every `.npmrc`, `~/.config/gh/`) without naming the file:
  // `kubectl config view --raw`/`--flatten`, `npm config get` of an `_auth`/
  // `_password` key, `gh auth status -t`/`--show-token`, `gh config get` of a
  // token key. The bundle that tightened them is the first to carry this entry.
  {
    version: '2026-09-23.4',
    field: 'allowedBashPatterns',
    label: 'bash pattern',
    patterns: [
      '^gh\\s+auth\\s+status\\b',
      '^gh\\s+config\\s+(get|list)\\b',
      '^npm\\s+(?:ls|list|view|info|show|outdated|audit(?!\\s+fix)(?!.*\\s--fix\\b)|search|explain|why|config\\s+get|config\\s+list)\\b',
      '^kubectl\\s+(?:get|describe|logs|top|explain|api-resources|api-versions|cluster-info(?!\\s+dump)|config\\s+view|config\\s+get-contexts|version)\\b',
    ],
  },
  // F1.1170 — the seed's hint texts, which the model reads when a command is
  // outside the read-only allowlist (Plan and Don't ask), named the retired
  // Explore mode and a long-gone "Ask mode". Hints merge by APPENDING a bundle
  // hint whose key the installed copy lacks, and `findBlockedCommandHint`
  // (mode-manager.ts) returns the FIRST hint for a command, so an installed seed
  // hint kept its old text ahead of the reworded one; `awk`'s reason did not
  // change, so its reworded hint was not even appended. A hint's identity here is
  // the merge's own key, `command::whenNotMatching::reason` ({@link retirementEntryKey});
  // `awk`'s is also its successor's, and retiring it is what lets the merge append
  // the new text. The same exact-match residue as above: an installed hint of the
  // user's own with a retired key goes too, and its line on stderr and in
  // boot.log names it. Identical in every bundle from the seed through
  // `2026-09-23.4`; `mode-manager-bash-hints.test.ts` holds the independent copy.
  {
    version: '2026-09-29',
    field: 'blockedCommandHints',
    label: 'command hint',
    patterns: [
      'printf::::printf is not in the default Explore-mode read-only allowlist.',
      'sed::^sed\\s+-n\\b::Only print-only sed is allowed in Explore mode by default.',
      'awk::::awk is blocked when the command appears to execute external commands.',
      'xargs::::xargs is not allowlisted in Explore mode because it can execute arbitrary commands from input.',
    ],
  },
  // UA12.184 `[security]` — upstream v0.14.0's two `gh api` entries, which bundle
  // `2026-10-09` shipped again (UA12.88, 2d9381e0c) in place of the anchored entry.
  // The PowerShell route of the read-only check reads a smart-quoted span (“…”) as
  // ONE word where bash splits it, so `gh api -X GET … -f “a=1 -X POST -f title=x”`
  // showed the argv inspector a GET while bash ran a POST: their `(?!.*--method)`
  // admitted it, the anchored entry refuses its ` -X ` / ` -f ` at the regex. Bundle
  // `2026-10-09.2` ships the anchored entry again and retires the two (the
  // `2026-09-23.2` entry above already names them; an install at `2026-10-09` crosses
  // only this one). UA12.88's `2026-10-09` retirement of the anchored string is
  // REMOVED with it: that string is shipped again, so nothing may retire it — a
  // profile at `2026-10-09` lacks it and the merge appends it from the bundle.
  {
    version: '2026-10-09.2',
    field: 'allowedBashPatterns',
    label: 'bash pattern',
    patterns: [
      '^gh\\s+api\\b.*--method\\s+GET\\b',
      '^gh\\s+api\\b(?!.*--method)',
    ],
  },
];

/**
 * One installed entry's identity for a retirement: an allow-list entry's
 * pattern string, or a `blockedCommandHints` entry's
 * `command::whenNotMatching::reason` — the key `migratePermissions` dedupes
 * hints by (F1.1170).
 */
function retirementEntryKey(entry: string | { pattern: string } | { command: string; whenNotMatching?: string; reason: string }): string {
  if (typeof entry === 'string') return entry;
  return 'pattern' in entry ? entry.pattern : `${entry.command}::${entry.whenNotMatching || ''}::${entry.reason}`;
}

/**
 * Drop the {@link RETIRED_SHIPPED_PATTERNS} an installed file still carries,
 * for every retirement this migration crosses. Returns the file unchanged (the
 * same object) when nothing is retired.
 */
function retireShippedPatterns(
  installed: PermissionsConfigFile,
  installedVersion: string,
  bundledVersion: string,
): PermissionsConfigFile {
  let result = installed;
  for (const retirement of RETIRED_SHIPPED_PATTERNS) {
    if (!(installedVersion < retirement.version && retirement.version <= bundledVersion)) continue;
    const entries = result[retirement.field];
    if (!entries) continue;
    const retired = new Set(retirement.patterns);
    const kept = entries.filter(entry => {
      const pattern = retirementEntryKey(entry);
      if (!retired.has(pattern)) return true;
      reportShippedPatternRetirement(`[Permissions] Retired the shipped ${retirement.label} "${pattern}" from the installed default.json (bundle ${retirement.version}); the bundle's current patterns replace it`);
      return false;
    });
    if (kept.length !== entries.length) result = { ...result, [retirement.field]: kept };
  }
  return result;
}

/**
 * F1.287 — the scoped form of one pattern from a SOURCE's `permissions.json`:
 * `^mcp__<slug>__(?:<pattern>)(?:_<word>)*$`. The pattern has to match at the
 * START of the tool segment and be followed by `_`-joined words or the end — the
 * shape F1.258 gave the shipped file (`resources/permissions/default.json`),
 * with the source's own slug in the server position.
 *
 * Until F1.287 this compiled `mcp__<slug>__.*<pattern>`, an unanchored substring:
 * a source configured the way `resources/docs/sources.md` §4 tells the agent to
 * (`get`, `list`) admitted `update_target`, `forget_memory` and `delete_playlist`
 * with no card in Explore, `default` and `dontAsk` (measured on
 * `runPreToolUseChecks`, `source-mcp-pattern-anchoring.test.ts`).
 *
 * Nothing on disk is rewritten, because the meaning the docs gave a bare verb —
 * "the tools of this kind" — is exactly what the anchored form keeps; a pattern
 * that is itself a regex keeps its own meaning inside the anchors (`.*_list`
 * still reaches `issues_list`, the author's explicit choice). The slug is
 * escaped, so a slug is matched as the literal it is.
 */
export function scopeSourceMcpPattern(sourceSlug: string, pattern: string): string {
  const slug = sourceSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^mcp__${slug}__(?:${pattern})(?:_[^_]+)*$`;
}

/**
 * F1.293 — the always-on report of one retired shipped string: stderr, and a
 * line appended to `<config dir>/logs/boot.log`. Until this row the line went to
 * `debug()` alone, which is gated on NESSY_DEBUG, so a packaged build wrote
 * nothing and a user entry spelled like a retired string vanished with no trace.
 *
 * `boot.log` is the startup sink the desktop's boot-fatal path already appends to
 * (`apps/electron/src/main/boot-fatal.ts`, `createBootDiagnosticWriter`, which
 * explains why electron-log cannot carry it), and the headless server shares it
 * through the same config directory. The report is written HERE, where the
 * retirement happens, because both hosts reach it through the one call they
 * already make (`ensureDefaultPermissions`), and a retirement runs only while a
 * profile crosses its version — so each line is written once, on that launch.
 * Both halves are best-effort: a closed stderr must not stop the file, and an
 * unusable config directory leaves stderr as the whole report.
 */
function reportShippedPatternRetirement(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // A closed stderr must not mask the file half below.
  }
  try {
    const logsDir = join(CONFIG_DIR, 'logs');
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, 'boot.log'), `${line}\n`, 'utf-8');
  } catch {
    // Unusable config directory — stderr above is the whole report then.
  }
}

/** F1.1002 — one sentence of the session's permission-policy notice, before translation. */
export interface PermissionPolicyNoticePart {
  key: 'chat.permissionPolicy.policyFailedClosed' | 'chat.permissionPolicy.documentsDropped' | 'chat.permissionPolicy.rulesDropped';
  count: number;
  /** Settings tiers to name, sorted; empty when none is known (the host renders `scopeUnknown`). */
  scopes: string[];
}

/**
 * F1.1002 — what the session's permission-policy notice says, from the carrier
 * `reportPermissionDslDiagnostics` built and the program's `invalidSource`.
 *
 * - A program that still FAILS CLOSED (a broken managed document, or P2.269's
 *   deny/ask cap overflow — `invalidSource`) refuses every call it judges on all
 *   three runtimes since F1.1002, so that is the one sentence: "every other rule
 *   still applies" would be false. Its diagnostic carries no scope and cannot be
 *   told apart from a rule drop, so nothing else is listed beside it.
 * - Otherwise a dropped FILE (F1.831's `droppedSources`, `document: true`) and a
 *   dropped RULE are separate sentences — until F1.1002 a whole ignored file was
 *   announced as "a permission rule … was skipped".
 */
export function permissionPolicyNoticeParts(
  diagnostics: readonly PermissionPolicyDiagnosticV1[],
  failedClosedScope?: PermissionDslScope,
): PermissionPolicyNoticePart[] {
  if (failedClosedScope !== undefined) {
    return [{ key: 'chat.permissionPolicy.policyFailedClosed', count: 1, scopes: [failedClosedScope] }];
  }
  const scopesOf = (list: readonly PermissionPolicyDiagnosticV1[]): string[] => [...new Set(
    list.map(diagnostic => diagnostic.scope).filter((scope): scope is PermissionDslScope => scope !== undefined),
  )].sort();
  const documents = diagnostics.filter(diagnostic => diagnostic.document === true);
  const rules = diagnostics.filter(diagnostic => diagnostic.document !== true);
  return [
    ...(documents.length > 0 ? [{ key: 'chat.permissionPolicy.documentsDropped' as const, count: documents.length, scopes: scopesOf(documents) }] : []),
    ...(rules.length > 0 ? [{ key: 'chat.permissionPolicy.rulesDropped' as const, count: rules.length, scopes: scopesOf(rules) }] : []),
  ];
}

/**
 * F1.715 — what a source's own `sources/<slug>/permissions.json` may contribute:
 * every restriction, and grants for that source's OWN tools only.
 *
 * The file is agent-writable by design (`session-filesystem-scope.ts`: the own
 * `sources/` is read+write, so the agent can set a source up), and measured on
 * `runPreToolUseChecks` it widened the WHOLE session: its `allowedBashPatterns`
 * ran `touch <anywhere>` with no card in five modes, its `allowedWritePaths`
 * opened Explore writes anywhere, and a `toolRules` or readable-policy allow
 * reached another source's write tool with no card (`source-permissions-own-tools-only.test.ts`).
 * The model is `settings-reference.md#allowmanagedpermissionrulesonly`'s for a
 * lower tier: "They only restrict, so they can't widen what the managed rules
 * grant". So the global grants are dropped here, before either applier or the
 * DSL sees the file — `allowedBashPatterns`, `allowedWritePaths`, and a
 * `toolRules` allow or a DSL allow rule that does not name this source's own
 * `mcp__<slug>__` tools. Kept: every deny, ask and block; the auto-scoped
 * `allowedMcpPatterns` (F1.287); `allowedTools`, which only ever narrows.
 * `allowedApiEndpoints` is kept: `applySourceConfig` scopes each of its rules to
 * this source's own `api_<slug>` tool (F1.1152 — before, they were global).
 *
 * A global grant belongs in the workspace's permissions (Settings > Permissions);
 * what was dropped is named in the debug log.
 */
export function sourceConfigOwnToolsOnly(
  config: PermissionsCustomConfig,
  sourceSlug: string,
): PermissionsCustomConfig {
  // A slug is a literal tool-name segment; one carrying a glob character could
  // not be told apart from a wider pattern, so it owns no grant at all.
  const ownPrefix = /[*?]/.test(sourceSlug) ? null : `mcp__${sourceSlug}__`;
  const ownToolRule = (rule: ToolPermissionRule) =>
    rule.action !== 'allow' || (ownPrefix !== null && rule.pattern.startsWith(ownPrefix));
  const toolRules = config.toolRules.filter(ownToolRule);
  const permissionDsl = config.permissionDsl && ownToolDslOnly(config.permissionDsl, sourceSlug);
  const dropped = config.allowedBashPatterns.length + config.allowedWritePaths.length
    + (config.toolRules.length - toolRules.length) + (permissionDsl?.dropped ?? 0);
  if (dropped === 0) return config;
  debug(
    `[Permissions] sources/${sourceSlug}/permissions.json: ${dropped} grant(s) outside the source's own tools ignored `
    + '(allowedBashPatterns, allowedWritePaths, or an allow rule for another tool); set them in the workspace permissions instead',
  );
  return {
    ...config,
    allowedBashPatterns: [],
    allowedWritePaths: [],
    toolRules,
    ...(permissionDsl ? { permissionDsl: permissionDsl.source } : {}),
  };
}

/** The DSL half of {@link sourceConfigOwnToolsOnly}: an allow rule survives only as an `mcp` matcher on this source's server. */
function ownToolDslOnly(
  source: PermissionDslSourceV1,
  sourceSlug: string,
): { source: PermissionDslSourceV1; dropped: number } {
  const document = source.document as { rules?: unknown } | undefined;
  // A document of any other shape is left to the compiler, which fails it closed.
  if (!document || typeof document !== 'object' || !Array.isArray(document.rules)) return { source, dropped: 0 };
  const rules = document.rules.filter(rule => {
    const r = rule as { action?: unknown; match?: { kind?: unknown; server?: unknown } } | null;
    return !r || r.action !== 'allow' || (r.match?.kind === 'mcp' && r.match.server === sourceSlug);
  });
  const dropped = document.rules.length - rules.length;
  return dropped === 0 ? { source, dropped } : { source: { ...source, document: { ...document, rules } }, dropped };
}
/**
 * **F1.1057 — the `deniedPaths` the user or an administrator added, i.e. every layer's
 * entries EXCEPT the credential floor Nessy ships.** Read BY LAYER, not by value, so an
 * entry a workspace or source file (or a managed or plugin layer) spells exactly like a
 * shipped one still counts as that layer's own.
 *
 * Owner decision 2026-09-28: codex runs with its OWN sandbox defaults, so
 * `CodexAgent.credentialFloorPatterns` mirrors this list, not {@link MergedPermissionsConfig.deniedPaths},
 * into codex's permission profile (`codexDenyReadEntryCount`, `config-writer-permissions.ts`,
 * says why: any `Deny` entry sends codex's AGENTS.md walk through its sandboxed helper,
 * 27-30 s per thread open measured with the shipped floor against 0.1-2.5 s without).
 * Pi and Claude Code keep reading `deniedPaths`, so the floor is unchanged there.
 *
 * What is left out: the `SAFE_MODE_CONFIG` seed `buildMergedConfig` starts from, and an
 * entry of the app's own `permissions/default.json` (scope `global`) that is one of the
 * shipped entries — that file is where the floor is installed, so a shipped line and a
 * user's identical line there are the same line. A user's own addition to that file is
 * kept. Residue, stated: an entry an older release shipped and a later one retired (the
 * `~/.npmrc` of before 2026-08-28) stays in an upgraded install's `default.json`, and
 * counts as the user's until they remove it; the codex session's
 * `codex-deny-read-slows-thread-open` line names the count.
 */
export interface MergedPermissionsConfig {
  deniedPathsBeyondShippedFloor?: string[];
}

const SHIPPED_DENIED_PATHS: ReadonlySet<string> = new Set(SAFE_MODE_CONFIG.deniedPaths ?? []);

function addDeniedPathBeyondShippedFloor(
  merged: MergedPermissionsConfig,
  pattern: string,
  scope: PermissionDslScope | undefined,
): void {
  if (scope === 'global' && SHIPPED_DENIED_PATHS.has(pattern)) return;
  const own = (merged.deniedPathsBeyondShippedFloor ??= []);
  if (!own.includes(pattern)) own.push(pattern);
}

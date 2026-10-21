/**
 * PermissionManager - Centralized Tool Permission Evaluation
 *
 * Provides a unified interface for checking tool permissions that both
 * ClaudeAgent and PiAgent can use. Delegates to the existing mode-manager
 * implementation to ensure consistent behavior.
 *
 * Key responsibilities:
 * - Evaluate tool calls against permission mode (dontAsk/plan/default/acceptEdits/auto/bypassPermissions)
 * - Check bash commands against read-only patterns
 * - Validate API endpoints against allowlists
 * - Provide detailed rejection reasons for blocked operations
 */

import { homedir } from 'os';
import {
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  shouldAllowToolInMode,
  isApiEndpointAllowed,
  type ToolCheckResult,
} from '../mode-manager.ts';
import { createLogger } from '../../utils/debug.ts';
import { getConfiguredAdditionalDirectories } from '../additional-directories.ts';
import { getBlockReadsOutsideWorkingDirectories } from '../../config/storage.ts';
import { parsePermissionsJson, permissionsConfigCache, sourceConfigOwnToolsOnly, type PermissionsContext, type PermissionsCustomConfig, type SessionPermissionRule } from '../permissions-config.ts';
import type { PermissionMode } from '../mode-types.ts';
import type { PermissionDslAction, PermissionDslV1 } from '../pi-harness/permission-dsl.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import type { PermissionManagerConfig, ToolPermissionResult } from './types.ts';
import { isDangerousCommandLine, isExactRememberKey } from './dangerous-commands.ts';

const log = createLogger('permissions');

// Re-export types for convenience
export type { ToolCheckResult, PermissionMode };

/**
 * Freeze a published permission layer set, all the way down.
 *
 * `buildCacheKey` identifies a pinned context by a sha256 over
 * `canonicalJson(context.pinnedConfigs)` — the CONTENT, not the reference — and
 * `getMergedConfig` then serves every later request for that key from one cached
 * merged config. Both halves rest on the same unwritten promise: once published,
 * a layer set never changes. Nothing enforced it. An in-place edit anywhere below
 * this array — `push` a layer, swap an `entry.config`, append one pattern to one
 * rule list — leaves the array reference intact, so a content memo keyed on that
 * reference keeps answering with the old digest, the old digest keeps selecting
 * the old entry, and the session goes on being policed by the rule set it had
 * before the edit. That is the P2.52 failure shape one layer up: a stale
 * permission answer served fast, with no fault anywhere to find.
 *
 * Freezing is what turns that promise into a fact. It was measured safe before
 * being applied, not assumed: a `parsePermissionsJson` layer holds only plain
 * objects, arrays and primitives (no `RegExp`, no `Map` — the merged config's
 * regexes are compiled downstream from these strings), and the merge reads the
 * layers without writing to them on either branch, the managed-only lock
 * included — `underLock` returns a spread copy rather than editing in place.
 *
 * The alternative was a comment, and the row this closes exists because a
 * comment already failed here once.
 */
function freezePublishedLayers<T>(value: T, seen = new Set<unknown>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezePublishedLayers(nested, seen);
  }
  return Object.freeze(value);
}

/**
 * D1.284 — the list itself lives in `./dangerous-commands.ts`, a leaf module
 * with no imports, so the permission card reads the SAME twenty names instead
 * of a copy pinned by a source-text test. The two methods below stay methods
 * because six call sites reach them through a `PermissionManager` (and
 * `pre-tool-use.ts` stubs that shape in tests), not because the answer needs a
 * manager.
 */

/**
 * PermissionManager provides centralized permission checking for agent backends.
 *
 * Usage:
 * ```typescript
 * const permManager = new PermissionManager({
 *   workspaceId: workspace.id,
 *   sessionId: session.id,
 *   workingDirectory: session.workingDirectory,
 *   plansFolderPath: getSessionPlansDir(workspace.id, session.id),
 * });
 *
 * // Check if a tool call is allowed
 * const result = permManager.evaluateToolCall('Bash', { command: 'git status' });
 * if (!result.allowed) {
 *   // Block with reason
 * }
 * ```
 */
export class PermissionManager {
  private config: PermissionManagerConfig;
  private permissionsContext: PermissionsContext;

  // Session-scoped whitelists for "always allow" feature
  private alwaysAllowedCommands: Set<string> = new Set();
  private alwaysAllowedDomains: Set<string> = new Set();

  constructor(config: PermissionManagerConfig) {
    this.config = config;
    // Build permissions context for loading custom permissions.
    // workspace `permissions.json` is loaded from the MANAGED workspace root —
    // NEVER the project workingDirectory (which is the command/file cwd). The
    // workingDirectory fallback exists only for legacy callers that predate the
    // explicit workspaceRootPath and never set a custom project cwd.
    this.permissionsContext = {
      workspaceRootPath: config.workspaceRootPath ?? config.workingDirectory ?? '',
    };
  }

  /**
   * Session-scoped rules a `PermissionRequest` hook added through
   * `updatedPermissions` with `destination: 'session'` (hooks.md § Permission
   * update entries: "in-memory only, discarded when the session ends").
   *
   * Kept OUTSIDE `permissionsContext` so a capability-generation change, which
   * rebuilds that context wholesale, cannot silently drop them: their lifetime
   * is the session, not the generation. The raw rule string is retained because
   * `removeRules` and `replaceRules` match on it.
   */
  private sessionPermissionRules: SessionPermissionRule[] = [];

  /** Adds one compiled session rule; returns false when it is already present. */
  addSessionPermissionRule(rule: SessionPermissionRule): boolean {
    if (this.sessionPermissionRules.some(existing => existing.raw === rule.raw && existing.action === rule.action)) {
      return false;
    }
    this.sessionPermissionRules.push(rule);
    return true;
  }

  /** `removeRules`: drops session rules of one behavior by their rule string. */
  removeSessionPermissionRules(action: PermissionDslAction, raws: readonly string[]): string[] {
    const wanted = new Set(raws);
    const removed = this.sessionPermissionRules
      .filter(rule => rule.action === action && wanted.has(rule.raw))
      .map(rule => rule.raw);
    this.sessionPermissionRules = this.sessionPermissionRules
      .filter(rule => !(rule.action === action && wanted.has(rule.raw)));
    return removed;
  }

  /** `replaceRules`: swaps every session rule of one behavior for the given set. */
  replaceSessionPermissionRules(action: PermissionDslAction, rules: readonly SessionPermissionRule[]): string[] {
    const dropped = this.sessionPermissionRules.filter(rule => rule.action === action).map(rule => rule.raw);
    this.sessionPermissionRules = [
      ...this.sessionPermissionRules.filter(rule => rule.action !== action),
      ...rules,
    ];
    return dropped;
  }

  listSessionPermissionRules(): readonly SessionPermissionRule[] {
    return this.sessionPermissionRules;
  }

  setCapabilityPermissionLayers(
    layers: Array<{
      content: string;
      sourceSlug?: string;
      scope?: 'builtin' | 'global' | 'workspace' | 'project';
      /**
       * D3 — the directory the layer's file was read from, so a `/`-anchored
       * path rule resolves against its own settings source. Absent for a layer
       * with no file behind it, and an anchored rule in one of those is dropped
       * at parse rather than left to fail the whole layer closed at compile.
       */
      sourceRoot?: string;
    }>,
    generation: string,
    projectTrusted = false,
    managedPermissionDsl?: PermissionDslV1,
    /**
     * `settings-reference.md#allowmanagedpermissionrulesonly` — "Make managed
     * settings the only settings source of permission rules. Claude Code then
     * ignores `allow`, `ask`, and `deny` rules in user, project, local, and
     * `--settings` files".
     *
     * Carried alongside the managed document rather than derived from it: the
     * lock engages with an EMPTY managed rule set, and that is its strictest,
     * most likely-to-be-intended configuration.
     */
    managedPermissionRulesOnly?: boolean,
  ): void {
    this.permissionsContext = {
      workspaceRootPath: this.permissionsContext.workspaceRootPath,
      pinnedRevision: generation,
      projectTrusted,
      ...(managedPermissionDsl ? { managedPermissionDsl } : {}),
      ...(managedPermissionRulesOnly ? { managedPermissionRulesOnly: true } : {}),
      pinnedConfigs: freezePublishedLayers(layers.map(layer => ({
        config: parsePermissionsJson(layer.content, layer.sourceRoot),
        ...(layer.sourceSlug ? { sourceSlug: layer.sourceSlug } : {}),
        // `builtin` is this method's OWN vocabulary; the cache and the DSL know
        // `managed`. The translation is a privilege decision, not a rename:
        // `managed` is the one scope `underLock` returns untouched, so a builtin
        // layer's grants are the only grants that survive
        // `allowManagedPermissionRulesOnly`. Drop the mapping and a builtin
        // layer arrives at an unknown scope, loses its grants under the lock,
        // and ranks nowhere in the DSL's SCOPE_WEIGHT.
        ...(layer.scope ? { scope: layer.scope === 'builtin' ? 'managed' as const : layer.scope } : {}),
      }))),
    };
  }

  clearCapabilityPermissionLayers(): void {
    this.permissionsContext = {
      workspaceRootPath: this.permissionsContext.workspaceRootPath,
    };
  }

  /**
   * The null case is unchanged on purpose: session rules ride the SAME pinned
   * generation as every other layer. Handing back a context whose
   * `pinnedRevision` is undefined would compile the program at generation
   * `live` while every caller evaluates at the capability generation, and
   * `evaluatePermissionDslV1` answers a generation mismatch with a blanket
   * deny — one hook rule would take the whole session down.
   */
  getCapabilityPermissionsContext(): PermissionsContext | null {
    if (this.permissionsContext.pinnedRevision === undefined) return null;
    const context = withLiveTightening(this.permissionsContext); // F1.1045 — a deny or ask edited in mid-turn binds from the next call
    return this.sessionPermissionRules.length === 0
      ? context : { ...context, sessionRules: this.sessionPermissionRules };
  }

  // ============================================================
  // Permission Mode Management
  // ============================================================

  /**
   * Composite session identity for this manager's mode-state singleton lookups.
   */
  private get modeKey(): SessionKey {
    return { workspaceId: this.config.workspaceId, sessionId: this.config.sessionId };
  }

  /**
   * Get the current permission mode for this session.
   */
  getPermissionMode(): PermissionMode {
    return getPermissionMode(this.modeKey);
  }

  /**
   * Set the permission mode for this session.
   */
  setPermissionMode(mode: PermissionMode): void {
    setPermissionMode(this.modeKey, mode);
  }

  /**
   * Cycle to the next permission mode (default: plan -> default -> acceptEdits -> auto -> bypassPermissions -> plan).
   * Returns the new mode.
   */
  cyclePermissionMode(enabledModes?: PermissionMode[]): PermissionMode {
    return cyclePermissionMode(this.modeKey, enabledModes);
  }

  // ============================================================
  // Tool Permission Evaluation
  // ============================================================

  /**
   * Evaluate whether a tool call is allowed under the current permission mode.
   *
   * This is the main entry point for permission checking. It considers:
   * - Current permission mode (dontAsk/plan/default/acceptEdits/auto/bypassPermissions)
   * - Tool type (Bash, Write, MCP, API, etc.)
   * - Tool input parameters
   * - Custom permission rules from permissions.json
   *
   * @param toolName - Name of the tool being called
   * @param toolInput - Input parameters for the tool
   * @returns ToolPermissionResult with allowed status and reason if blocked
   */
  evaluateToolCall(
    toolName: string,
    toolInput: Record<string, unknown>
  ): ToolPermissionResult {
    const mode = this.getPermissionMode();

    // Use shouldAllowToolInMode which handles all the complex logic
    const result = shouldAllowToolInMode(toolName, toolInput, mode, {
      plansFolderPath: this.config.plansFolderPath,
      dataFolderPath: this.config.dataFolderPath,
      additionalDirectories: getConfiguredAdditionalDirectories(),
      // P6.809 - the operator's read fence, which DECLINES TO ANSWER without
      // both of these: `getReadsOutsideWorkingDirectoriesViolation` returns null
      // when the flag is not `true`, and again when no `workingDirectory` was
      // supplied, because it will not invent a base to measure containment
      // against. So a gate that omitted them was not enforcing a fence that
      // failed open - it was silently opting out of one, which is worse,
      // because the setting reads as on everywhere it is shown.
      //
      // This gate is one of the two that take an ARBITRARY tool name, so it is
      // one of the two where the fence (Read/Grep/Glob/Find/Ls) can actually
      // fire. `this.config.workingDirectory` was already here; only the reading
      // of it was missing.
      ...(this.config.workingDirectory ? { workingDirectory: this.config.workingDirectory } : {}),
      blockReadsOutsideWorkingDirectories: getBlockReadsOutsideWorkingDirectories(),
      permissionsContext: withLiveTightening(this.permissionsContext), // F1.1045, as getCapabilityPermissionsContext
    });

    if (result.allowed) {
      if ('requiresPermission' in result && result.requiresPermission) {
        log.info('Tool requires permission', {
          sessionId: this.config.sessionId,
          mode,
          toolName,
          description: result.description,
          toolInput,
        });
        return {
          allowed: true,
          requiresPermission: true,
          description: result.description,
        };
      }
      log.debug('Tool allowed', {
        sessionId: this.config.sessionId,
        mode,
        toolName,
      });
      return { allowed: true };
    }

    log.warn('Tool blocked', {
      sessionId: this.config.sessionId,
      mode,
      toolName,
      reason: result.reason,
      toolInput,
    });

    return {
      allowed: false,
      reason: result.reason,
    };
  }

  // `checkBashCommand` lived here until P6.578 and was DELETED, not wired. It
  // duplicated `shouldAllowToolInMode`'s bash branch (`mode-manager.ts`, the
  // same `getBashRejectionReason` + `formatBashRejectionMessage` pair) and had
  // ZERO product callers — only its own test — so a guard added to it would
  // have gated nothing while reading like an execution gate. The live refusal
  // seam for a bash command is `shouldAllowToolInMode`; add to that one.

  // D1.307 — `requiresBashPermission` lived here and was DELETED, not wired, for
  // the same reason `checkBashCommand` above was: ZERO product callers, only its
  // own test. D1.285 corrected its BEHAVIOUR (it tested the base command, so it
  // answered `false` for `sudo apt install x` and for all four two-word entries)
  // without that changing anything a user meets, which is the shape this deletion
  // ends. Its contract sentence — the one the list's own header makes, that these
  // commands always require permission in ask mode — now sits on
  // `isDangerousCommandLine`, the predicate that does the work; its cases moved
  // there too. The live ask-mode seam is `shouldPromptInAskMode`, whose Bash arm
  // tests the whole command line against that predicate.

  // ============================================================
  // API Endpoint Checking
  // ============================================================

  /**
   * Check if an API endpoint is allowed based on method and path.
   * GET requests are always allowed. Other methods check against allowlist.
   *
   * @param method - HTTP method (GET, POST, etc.)
   * @param path - API endpoint path
   * @returns true if the endpoint is allowed
   */
  isApiEndpointAllowed(method: string, path?: string, toolName?: string): boolean {
    return isApiEndpointAllowed(method, path, this.permissionsContext, toolName); // F1.1152
  }

  // ============================================================
  // Command Analysis Utilities
  // ============================================================

  /**
   * Extract the base command (first word) from a bash command string.
   * Handles pipes, redirects, and other shell constructs.
   *
   * @param command - Full bash command
   * @returns Base command name
   */
  getBaseCommand(command: string): string {
    const trimmed = command.trim();
    // Extract first word, handling common prefixes
    const match = trimmed.match(/^(?:sudo\s+)?(\S+)/);
    return match?.[1] ?? trimmed.split(/\s+/)[0] ?? '';
  }

  /**
   * Check if a command is in the dangerous commands list.
   *
   * Accepts EITHER a base command (`getBaseCommand`'s output) OR a whole
   * command line, and a caller holding the whole line should pass the whole
   * line. D1.285 — the four two-word entries could never match: every caller
   * looked up a one-word base command, so `git push origin main` answered
   * `false` on both of the spellings `persistBashAlwaysAllowRule` checks while
   * `rm -rf build` answered `true` (the control). The pair arm cannot fire
   * without a second token, so every existing one-token caller answers exactly
   * what it answered before.
   *
   * @param command - Base command name (from getBaseCommand) or a full command line
   * @returns true if command is dangerous
   */
  isDangerousCommand(command: string): boolean {
    return isDangerousCommandLine(command);
  }

  // F1.98 (origin D1.415) — `isDangerousCommandPrefix` lived here and was
  // DELETED, not wired, for the reason `checkBashCommand` and
  // `requiresBashPermission` above were: ZERO product callers. The census at
  // HEAD `1b01e1c27` (`git grep` over `packages` and `apps`) named its own five
  // test assertions and its declaration, nothing else. Its one caller was
  // `SessionManager.persistBashAlwaysAllowRule`, and D1.404 replaced that
  // narrowing with `bashSessionWhitelistKey` — the key the session grant uses —
  // which reaches the predicate that does the work, `headsDangerousCommandPair`
  // in `dangerous-commands.ts`, directly. A one-line wrapper with no caller
  // reads like a live seam while gating nothing. The capability is not lost:
  // ask `headsDangerousCommandPair`, whose five cases moved with this deletion
  // (`__tests__/permission-manager.test.ts`, beside the ones in
  // `bash-session-whitelist-dangerous-prefix.test.ts`). The file keeps its line
  // count because the ledgers cite lines below this one.

  /**
   * Extract domain from network commands (curl, wget, ssh, etc.)
   * Used for domain whitelisting checks.
   *
   * @param command - Full bash command
   * @returns Domain if found, null otherwise
   */
  extractDomainFromNetworkCommand(command: string): string | null {
    // Match common patterns for URLs and hostnames
    const urlMatch = command.match(/https?:\/\/([^\/\s:]+)/);
    if (urlMatch?.[1]) {
      return urlMatch[1];
    }

    // Match ssh-style user@host patterns
    const sshMatch = command.match(/@([^\s:]+)/);
    if (sshMatch?.[1]) {
      return sshMatch[1];
    }

    return null;
  }

  // ============================================================
  // Context Management
  // ============================================================

  /**
   * Update the working directory (used for permission context).
   */
  updateWorkingDirectory(path: string): void {
    // Only the command/file cwd moves; the workspace permissions root is a
    // managed-storage invariant and must NOT follow the project cwd.
    this.config.workingDirectory = path;
  }

  /**
   * Update the plans folder path.
   */
  updatePlansFolderPath(path: string): void {
    this.config.plansFolderPath = path;
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string {
    return this.config.sessionId;
  }

  /**
   * Get the permissions context for external use.
   */
  getPermissionsContext(): PermissionsContext {
    return this.permissionsContext;
  }

  // ============================================================
  // Session-Scoped Whitelisting
  // ============================================================

  /**
   * Check if a base command has been whitelisted for this session.
   */
  isCommandWhitelisted(baseCommand: string): boolean {
    // UA12.70 — an exact-argv key keeps its case (`-n` and `-N` are different argv).
    return this.alwaysAllowedCommands.has(isExactRememberKey(baseCommand) ? baseCommand : baseCommand.toLowerCase());
  }

  /**
   * Whitelist a command for the remainder of the session.
   * Called when user clicks "Always Allow" for a command.
   */
  whitelistCommand(baseCommand: string): void {
    this.alwaysAllowedCommands.add(isExactRememberKey(baseCommand) ? baseCommand : baseCommand.toLowerCase());
  }

  /**
   * Check if a domain has been whitelisted for network commands.
   */
  isDomainWhitelisted(domain: string): boolean {
    return this.alwaysAllowedDomains.has(domain.toLowerCase());
  }

  /**
   * Whitelist a domain for network commands.
   * Called when user clicks "Always Allow" for curl/wget to a domain.
   */
  whitelistDomain(domain: string): void {
    this.alwaysAllowedDomains.add(domain.toLowerCase());
  }

  /**
   * Clear all session-scoped whitelists.
   * Called on session clear or dispose.
   */
  clearWhitelists(): void {
    this.alwaysAllowedCommands.clear();
    this.alwaysAllowedDomains.clear();
  }

  /**
   * Get the set of whitelisted commands (for debugging).
   */
  getWhitelistedCommands(): Set<string> {
    return new Set(this.alwaysAllowedCommands);
  }

  /**
   * Get the set of whitelisted domains (for debugging).
   */
  getWhitelistedDomains(): Set<string> {
    return new Set(this.alwaysAllowedDomains);
  }

  /**
   * UA12.73 — the hosts an Always Allow on a curl/wget card grants: EVERY host of one plain
   * command ({@link getNetworkCommandHosts}, upstream v0.14.0), so the approved line is covered on
   * its next run and nothing chained onto it is; an empty list for a line that cannot be vouched
   * for (a chain, a redirect, `-K`/`--config`, a routing option, an unparsable URL), which then
   * grants nothing. {@link extractDomainFromNetworkCommand} (first URL only) still names the card.
   */
  networkCommandHosts(command: string): string[] {
    return getNetworkCommandHosts(command) ?? [];
  }
}

// UA12.73 — below every docs-cited line (highest 475): the curl/wget grant's hosts.
import { getNetworkCommandHosts } from './network-command-hosts.ts';

/**
 * **F1.1045 — a `permissions.json` edit made DURING a turn: its new `deny` and `ask` rules bind
 * from the next tool call of that turn; its allow rules wait for the next turn.**
 *
 * `permissions.md`: "when you add or remove a rule, Claude Code applies the change starting
 * with Claude's next tool call in the same turn". A turn's layers are pinned to its capability
 * snapshot ({@link PermissionManager.setCapabilityPermissionLayers}), so without this an edit
 * reached the next turn only. Native-first: our `permissions.json` is the host's own file, so
 * the host seam is the one place all three runtimes read it (this context is what claude's
 * PreToolUse hook, Pi's pre-tool gate and codex's host consult evaluate); controller decision
 * DECISIONS-2.md Q12.
 *
 * What it reads: the LIVE copy of each pinned layer that the config cache holds and the config
 * watcher invalidates — the workspace `permissions.json` (the one `workspace`-scope layer with no
 * source slug) and each source's `permissions.json` (a layer with that slug), the two files
 * `native-sources.ts` inventories at those positions. When
 * the live copy differs from the pinned one, its TIGHTENING half is appended as one more layer
 * at the same scope and slug: `deny`/`ask` DSL rules and tool rules, `deniedPaths`,
 * `deniedToolPatterns`, `disallowedTools`, `blockedTools`. Every grant field and every `allow`
 * rule is dropped, so a mid-turn edit can only restrict: a removed deny and a new allow both
 * wait for the next turn's snapshot, and the pinned layer still stands until then.
 *
 * F1.1188 (DN-291, 2026-09-29) — `toolRules` is read first-match-wins, so a deny appended after
 * the pinned layers lost to that layer's own `allow` for the same tool (`allow mcp__linear__*`
 * pinned, `deny mcp__linear__delete_*` added above it: the delete ran with no card). The live
 * copy's deny and ask tool rules that come BEFORE its first allow rule therefore also lead the
 * pinned layer's own tool rules ({@link unshadowedTighteningToolRules}): no allow in the live
 * file can shadow them, so they bind after the earlier layers' rules, ahead of this file's old
 * ones. A lead `ask` must never outrank a pinned `deny` (an edit of a deny to ask, or a broader
 * ask above it, would turn the turn's refusal into an approval card), so asks lead only while no
 * pinned layer at all holds a deny tool rule (any file: RF-a, 2026-10-01; docs-site). Residue,
 * until the next turn: a rule placed after an allow in the live file (and, while asks may not
 * lead, every ask and each rule after it) stays in the appended layer, binding where no pinned
 * rule matches the tool — chosen over denying a tool the live file allows or loosening a deny.
 *
 * Residue, stated: the app's `permissions/default.json`, a project's `.nessy-agent/permissions.json`
 * and Claude settings files are not in that cache and still apply from the next turn; a live
 * file whose readable-rules block does not parse contributes its other fields only (the next
 * turn applies the whole file with its usual posture). Cost of an unchanged file: one map
 * lookup (one `stat` for a source file) per call, memoized on the cache's own objects.
 */
function withLiveTightening(context: PermissionsContext): PermissionsContext {
  const pinned = context.pinnedConfigs;
  if (!pinned || pinned.length === 0) return context;
  const live = pinned.map(layer => liveCopyOf(context.workspaceRootPath, layer));
  const memo = liveTighteningMemo.get(context);
  if (memo && memo.live.length === live.length && memo.live.every((entry, index) => entry === live[index])) {
    return memo.context;
  }
  const extra: NonNullable<PermissionsContext['pinnedConfigs']> = [];
  const layers = pinned.map((layer, index) => {
    const fresh = live[index];
    if (!fresh || sameDocument(fresh, layer.config)) return layer;
    const config = tighteningHalf(fresh);
    if (!config) return layer;
    extra.push({
      config,
      ...(layer.sourceSlug ? { sourceSlug: layer.sourceSlug } : {}),
      ...(layer.scope ? { scope: layer.scope } : {}),
    });
    const asksMayLead = !pinned.some(other => other.config.toolRules.some(rule => rule.action === 'deny')); // any file
    const lead = unshadowedTighteningToolRules(fresh, layer.sourceSlug, asksMayLead); // F1.1188
    return lead.length === 0 ? layer : { ...layer, config: { ...layer.config, toolRules: [...lead, ...layer.config.toolRules] } };
  });
  const result = extra.length === 0
    ? context
    : { ...context, pinnedConfigs: freezePublishedLayers([...layers, ...extra]) };
  if (extra.length > 0) {
    log.info('A permissions.json edited during the turn restricts it from this call on (F1.1045)', { layers: extra.length });
  }
  liveTighteningMemo.set(context, { live, context: result });
  return result;
}

/** Keyed by the published context, so a new turn's context starts a new memo. */
const liveTighteningMemo = new WeakMap<PermissionsContext, {
  live: ReadonlyArray<PermissionsCustomConfig | null>;
  context: PermissionsContext;
}>();

function liveCopyOf(
  workspaceRootPath: string,
  layer: NonNullable<PermissionsContext['pinnedConfigs']>[number],
): PermissionsCustomConfig | null {
  if (layer.scope !== 'workspace') return null; // default.json (global) and project files are not in the cache
  return layer.sourceSlug
    ? permissionsConfigCache.getSourceConfig(workspaceRootPath, layer.sourceSlug)
    : permissionsConfigCache.getWorkspaceConfig(workspaceRootPath);
}

/** The same parse, whichever spelling of the file's directory each side was handed. */
function sameDocument(live: PermissionsCustomConfig, pinned: PermissionsCustomConfig): boolean {
  return JSON.stringify({ ...live, sourceRoot: undefined }) === JSON.stringify({ ...pinned, sourceRoot: undefined });
}

/**
 * F1.1188 — the live copy's `deny` and `ask` tool rules ahead of its first `allow` rule, which no
 * allow in that file can shadow under first-match-wins; when `asksMayLead` is false (a pinned deny
 * a lead ask could outrank), only the denies ahead of its first allow OR ask, so no deny leads past
 * an ask the live file reads first. A source file is read as the merge reads it
 * ({@link sourceConfigOwnToolsOnly}), so an allow it may not grant does not count as a shadow.
 */
function unshadowedTighteningToolRules(
  live: PermissionsCustomConfig,
  sourceSlug: string | undefined,
  asksMayLead: boolean,
): PermissionsCustomConfig['toolRules'] {
  const rules = sourceSlug ? sourceConfigOwnToolsOnly(live, sourceSlug).toolRules : live.toolRules;
  const end = rules.findIndex(rule => rule.action === 'allow' || (rule.action === 'ask' && !asksMayLead));
  return end === -1 ? [...rules] : rules.slice(0, end);
}

function tighteningHalf(config: PermissionsCustomConfig): PermissionsCustomConfig | undefined {
  const dsl = config.permissionDsl;
  const document = dsl && !dsl.diagnostic ? dsl.document as { rules?: unknown } | undefined : undefined;
  const rules = document && Array.isArray(document.rules)
    ? document.rules.filter(rule => (rule as { action?: unknown } | null)?.action !== 'allow')
    : undefined;
  const toolRules = config.toolRules.filter(rule => rule.action !== 'allow');
  const restricts = (rules?.length ?? 0) > 0 || toolRules.length > 0 || config.deniedPaths.length > 0
    || config.deniedToolPatterns.length > 0 || config.disallowedTools.length > 0 || config.blockedTools.length > 0;
  if (!restricts) return undefined;
  return {
    allowedBashPatterns: [],
    allowedMcpPatterns: [],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
    allowedTools: [],
    blockedCommandHints: [],
    deniedPaths: config.deniedPaths,
    deniedToolPatterns: config.deniedToolPatterns,
    disallowedTools: config.disallowedTools,
    toolRules,
    blockedTools: config.blockedTools,
    ...(config.sourceRoot === undefined ? {} : { sourceRoot: config.sourceRoot }),
    ...(dsl && rules && rules.length > 0
      ? { permissionDsl: { sourceDigest: dsl.sourceDigest, document: { ...document, rules } } }
      : {}),
  };
}

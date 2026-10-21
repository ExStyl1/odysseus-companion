/**
 * The `claudeMdExcludes` equivalent (R28), resolved across every documented
 * settings scope (R31 · f185).
 *
 * `memory.md`, "Exclude specific CLAUDE.md files": "In large monorepos, ancestor
 * CLAUDE.md files may contain instructions that aren't relevant to your work.
 * The `claudeMdExcludes` setting lets you skip specific files by path or glob
 * pattern... Patterns are matched against absolute file paths using glob syntax.
 * You can configure `claudeMdExcludes` at any settings layer: user, project,
 * local, or managed policy. Arrays merge across layers."
 *
 * `large-codebases.md:155`, verbatim and re-verified 2026-08-04: "Managed policy
 * CLAUDE.md files cannot be excluded, so organization-wide instructions always
 * apply. You can set `claudeMdExcludes` at any [settings
 * scope](/docs/en/settings#configuration-scopes): user, project, local, or
 * managed. Arrays merge across scopes, so a team can set project-level defaults
 * while individuals add local overrides." The page's own worked example is at
 * the LOCAL scope (`:137` — "If you only want these exclusions for yourself, put
 * the setting in `.claude/settings.local.json`"), which is the scope this
 * repository read LAST, not first.
 *
 * The documented example excludes a whole package's rules directory
 * (`"/home/user/monorepo/other-team/.claude/rules/**"`), which is why this
 * covers instruction files AND rule files with one matcher.
 *
 * The doc-verification entry told us to reuse P8's `claudeMdExcludes` matcher.
 * There was none — the symbol did not exist anywhere in this repository — so
 * this is it.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadStoredConfig } from '../../config/storage.ts';
import type { ProjectTrustState, SettingSource } from '../../capabilities/types.ts';
import { parsePermissionJsonc } from '../pi-harness/permission-dsl.ts';
import { compileRuleGlob } from './rule-matching.ts';

/**
 * Our own key, plus Claude's spelling: we import Claude's config shapes, and a
 * repository that already carries `claudeMdExcludes` should behave the same
 * here. Both are read and, per the docs, the arrays MERGE.
 */
export const INSTRUCTION_EXCLUDE_SETTING_KEYS = ['instructionExcludes', 'claudeMdExcludes'] as const;

/** Where a `.claude` settings file lives, relative to the project directory. */
const CLAUDE_SETTINGS_FILES = {
  project: join('.claude', 'settings.json'),
  local: join('.claude', 'settings.local.json'),
} as const;

/**
 * The USER scope's Claude settings file — P6.32.
 *
 * This leg did not exist, and its absence was the shape the parity ledger calls
 * "two stacks": the SDK subprocess we spawn passes
 * `settingSources: ['user', 'project', 'local']`, so it reads
 * `~/.claude/settings.json` and honours a `claudeMdExcludes` written there
 * (`claudeMdExcludes` occurs 3 times in the shipped 2.1.223 native binary,
 * positive control `permissions` 616, negative control `nessyNotARealSdkKey` 0);
 * this resolver read the project and local files and, for USER, only Nessy's own
 * `config.json`. So a pattern in the file the page names for that scope was
 * honoured by claude's own memory loader and ignored by ours — on Pi and codex it
 * did nothing at all.
 *
 * The page settles both halves. `settings-reference.md#claudemdexcludes` gives
 * the key's **Scope** as `Any file`, and the scope legend above the table
 * (`settings-reference.md#scopes`) spells that out verbatim: "`User` is
 * `~/.claude/settings.json`, `Project` is `.claude/settings.json`, `Local` is
 * `.claude/settings.local.json`, and `Managed` is what your organization
 * deploys. `Any file` means all four". `large-codebases.md` says the same in
 * prose — "You can set `claudeMdExcludes` at any settings scope: user, project,
 * local, or managed. Arrays merge across scopes" — which this module's own
 * docblock already quoted while implementing three of the four.
 *
 * Both user-scope files are read and unioned, never one instead of the other:
 * `config.json` is OUR user scope and carries `instructionExcludes`, and
 * `~/.claude/settings.json` is the one the page names. Union is the same
 * direction the rest of this resolver takes and the safe one for a
 * restrict-direction key.
 */
const CLAUDE_USER_SETTINGS_FILE = 'settings.json';

/**
 * `~/.claude`, or wherever `CLAUDE_CONFIG_DIR` moved it —
 * `env-vars.md#variables`, the `CLAUDE_CONFIG_DIR` row: "Override the
 * configuration directory (default: `~/.claude`). All settings, session history,
 * and plugins are stored under this path".
 *
 * RESIDUE, stated rather than hidden: a Workspace redirects the CHILD's config
 * dir (`agent/options.ts` assigns `CLAUDE_CONFIG_DIR` from
 * `workspaceClaudeConfigDir`), and this resolver follows only when the host's own
 * environment carries the same value. A caller that knows the workspace passes
 * {@link InstructionExcludeScopesV1.claudeConfigDirectory} instead of relying on
 * the default.
 */
function defaultClaudeConfigDirectory(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.claude');
}

/** A settings file this size is not a settings file; refuse to read it. */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

function normalizeAbsolute(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * A predicate over ABSOLUTE paths. An unreadable pattern excludes nothing
 * instead of throwing — the same posture the rule matcher takes, since an
 * exclusion that crashes discovery is strictly worse than one that misses.
 */
export function createInstructionExcludeMatcher(
  patterns: readonly unknown[],
): (absolutePath: string) => boolean {
  const compiled = patterns
    .filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim().length > 0)
    .map(pattern => compileRuleGlob(pattern.trim()))
    .filter((regex): regex is RegExp => regex !== null);

  if (compiled.length === 0) return () => false;

  return (absolutePath: string) => {
    const target = normalizeAbsolute(absolutePath);
    // A pattern may be written absolute (`/home/user/…/**`) or rooted at any
    // ancestor (`**/monorepo/CLAUDE.md`); the second form cannot consume the
    // leading slash, so the slash-less spelling is tried too.
    const withoutLeadingSlash = target.replace(/^\/+/, '');
    return compiled.some(regex => regex.test(target) || regex.test(withoutLeadingSlash));
  };
}

/** Append every usable string in `entries` that is not already in `into`. */
function collectPatterns(into: string[], entries: unknown): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed && !into.includes(trimmed)) into.push(trimmed);
  }
}

/** Both spellings out of one already-parsed settings object. */
function collectFromSettingsObject(into: string[], root: unknown): void {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return;
  const record = root as Record<string, unknown>;
  for (const key of INSTRUCTION_EXCLUDE_SETTING_KEYS) collectPatterns(into, record[key]);
}

/**
 * One `.claude` settings file's exclusion arrays, and NOTHING else out of the
 * document.
 *
 * Read with `parsePermissionJsonc`, the reader `claude-settings-store.ts`
 * already uses for these files, so a file with comments or trailing commas is
 * read the same way by both consumers. Fails open in every failure mode: this
 * file is co-owned with real Claude Code, and a key we do not understand — or a
 * document we cannot parse — must never make our own discovery throw.
 */
function collectFromClaudeSettingsFile(into: string[], path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return;
  }
  if (raw.length > MAX_SETTINGS_FILE_BYTES) return;
  let parsed: unknown;
  try {
    parsed = parsePermissionJsonc(raw);
  } catch {
    return;
  }
  collectFromSettingsObject(into, parsed);
}

export interface InstructionExcludeScopesV1 {
  /**
   * The MANAGED scope's `claudeMdExcludes`, already parsed off the composed
   * managed policy (`ManagedPiPolicyV1.claudeMdExcludes`).
   *
   * Passed in rather than read here: only the bootstrap that composed the
   * managed sources knows which one won, and `packages/shared` cannot reach the
   * loader that does it (`packages/server-core`).
   */
  readonly managed?: readonly string[] | undefined;
  /**
   * The project directory whose `.claude/settings.json` and
   * `.claude/settings.local.json` carry the project and local scopes. Absent =
   * neither scope contributes, which is the no-project case.
   */
  readonly workingDirectory?: string | undefined;
  /**
   * Repository-owned settings are read ONLY for a trusted project. Anything
   * other than `'trusted'` — including `undefined`, for a caller that does not
   * know — contributes nothing, so an untrusted checkout cannot reach into the
   * memory pipeline at all.
   */
  readonly projectTrustState?: ProjectTrustState | undefined;
  /**
   * Active `--setting-sources`. Absent means all sources, the CLI default;
   * present and omitting `user`/`project`/`local` drops that scope's leg,
   * mirroring `projectSourceEnabled` in `capabilities/native-sources.ts`.
   */
  readonly settingSources?: readonly SettingSource[] | undefined;
  /**
   * Where the USER scope's `~/.claude/settings.json` lives. Absent, the
   * `CLAUDE_CONFIG_DIR` default is used — see
   * {@link defaultClaudeConfigDirectory} for the residue that leaves.
   */
  readonly claudeConfigDirectory?: string | undefined;
}

/**
 * Every scope's exclusion patterns, UNIONED and de-duplicated.
 *
 * ## Why union rather than override
 *
 * `settings.md#lists-merge-instead-of-overriding` is the general rule and it
 * already answers this: "When you set the same list key, such as
 * `permissions.allow`, in more than one file, Claude Code combines the lists
 * instead of picking one, so each file can add entries without removing another
 * file's." Read 2026-09-10, and the exception list has GROWN since this comment
 * was written: the page now names FOUR model-list keys that follow their own
 * rules — `fallbackModel`, `modelPicker`, `availableModels`, `modelSettings` —
 * where this comment said two. `claudeMdExcludes` is none of them, and
 * `large-codebases.md:155` states the merge for this key by name.
 *
 * It is also the safe direction, which is what settles it when the doc and our
 * own posture could disagree. This is a RESTRICT-direction key: every entry
 * REMOVES a file from context. Union means a lower-precedence scope's exclusion
 * cannot be silently un-done by a higher-precedence scope that merely forgot to
 * repeat it — the failure mode of override here is a user's `settings.local.json`
 * quietly re-admitting the whole vendored tree their team excluded at project
 * scope. (R31 decision constraint 3: for a restrict-direction key the more
 * restrictive value wins.) There is deliberately NO way to subtract an
 * inherited exclusion; `large-codebases.md:135` offers starting Claude from the
 * package directory instead, and that stays the answer.
 *
 * Fails open leg by leg. An unreadable file, a bad JSON document or a
 * `loadStoredConfig()` that throws contributes nothing and never propagates —
 * this reader has swallowed that throw since R28, and the fix for the throw
 * itself is declaring the keys in the strict envelope (`config/validators.ts`),
 * not making discovery fatal.
 *
 * Called with no arguments it is the USER scope alone, which is the correct
 * answer for a caller that has no project context and must not guess one.
 */
export function resolveInstructionExcludes(scopes: InstructionExcludeScopesV1 = {}): string[] {
  const merged: string[] = [];

  // Managed first so its entries lead the list. Order carries no meaning for a
  // union of exclusions, but a stable order keeps the compiled matcher — and
  // any diagnostic that prints the list — reproducible.
  collectPatterns(merged, scopes.managed);

  const sources = scopes.settingSources;
  const enabled = (source: SettingSource): boolean => sources === undefined || sources.includes(source);

  // USER: `CONFIG_DIR/config.json`, both spellings.
  try {
    collectFromSettingsObject(merged, loadStoredConfig() ?? undefined);
  } catch {
    // A config.json that fails the strict envelope contributes no exclusions
    // rather than failing memory discovery. See the class comment.
  }

  // USER, the scope the PAGE names: `~/.claude/settings.json`. No trust gate —
  // this file is the user's own, not the repository's, which is exactly why it
  // sits outside the `projectTrustState` branch below.
  if (enabled('user')) {
    collectFromClaudeSettingsFile(
      merged,
      join(scopes.claudeConfigDirectory ?? defaultClaudeConfigDirectory(), CLAUDE_USER_SETTINGS_FILE),
    );
  }

  const projectDirectory = scopes.workingDirectory;
  if (projectDirectory && scopes.projectTrustState === 'trusted') {
    for (const source of ['project', 'local'] as const) {
      if (!enabled(source)) continue;
      collectFromClaudeSettingsFile(merged, join(projectDirectory, CLAUDE_SETTINGS_FILES[source]));
    }
  }

  return merged;
}

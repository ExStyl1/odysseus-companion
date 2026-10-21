/**
 * Import a Claude Code setup into a Nessy workspace (P2.9).
 *
 * The setup is read from `~/.claude`, or from wherever `CLAUDE_CONFIG_DIR` moved
 * it when no caller named a directory — see {@link resolveDirs}, and
 * {@link resolveClaudeProjectDirNameOverride} for the one thing that may only be
 * read alongside it. `~/.claude` is written below wherever the distinction does
 * not matter to the sentence.
 *
 * This is a CONVERTER, not a new set of parsers. Every artifact kind is read
 * through the SAME reader the product already treats as a native `~/.claude`
 * layer, and written through the SAME writer the rest of the app uses for that
 * kind:
 *
 * | Kind         | Reader (reused, no new parser)                                   | Writer (reused)                                   |
 * | ------------ | ---------------------------------------------------------------- | ------------------------------------------------- |
 * | instruction  | plain read of `~/.claude/CLAUDE.md`                              | merge-block into `<ws>/AGENTS.md`                  |
 * | permission   | `parsePermissionsJson` (recognizes the Claude `permissions` block via `claudeSettingsPermissionDsl` → `parseClaudeRuleString`) | `saveWorkspacePermissions` |
 * | skill        | `skillRecords` (the native `<dir>/<slug>/SKILL.md` reader) on `~/.claude/skills` | copy `skills/<slug>/` into `<ws>/skills/<slug>/` |
 * | mcp          | `mcpServerRecords` (the native `{mcpServers}` reader) on `~/.claude.json` / `~/.claude/.mcp.json` | `saveSourceConfig` (workspace MCP source) |
 * | hook         | `parseHooksConfigContent` (the native hooks/automations reader) on `~/.claude/settings.json`'s `hooks` block | merge into `<ws>/hooks.json` |
 * | agent        | `readUserAgentDefinitions` (the native markdown-agent reader) pointed at `~/.claude/agents` | copy each `<name>.md` to `<ws>/<name>.md` |
 * | command      | plain `.md` listing of `~/.claude/commands`, named by `listCustomSlashCommands`' own filename rule | copy each `<name>.md` to `<ws>/.nessy-agent/commands/<name>.md` |
 * | memory       | plain `.md` listing of `~/.claude/projects/<project>/memory` (P6.521) | copy each file to `<ws>/<name>.md`, index included |
 * | setting      | the interactive keys of `~/.claude/settings.json` (P6.520)       | `setSpellCheck`, the installation-global writer     |
 *
 * Two of those readers take a SECOND home since P6.523 — `<codex home>`'s
 * `AGENTS.override.md`/`AGENTS.md` feed the instruction kind, and its
 * `config.toml`'s `[mcp_servers.*]` feed the mcp kind — through the same writers
 * and the same badges. The boundary of what codex supplies, and what it
 * deliberately does not, is on `CODEX_INSTRUCTION_FILES`.
 *
 * Two phases, one conversion. {@link computeClaudeSetupImportPlan} performs the
 * full read and returns a plan describing every change WITHOUT writing anything
 * (the dry-run preview). {@link applyClaudeSetupImportPlan} performs the writes.
 * Cancelling is simply never calling apply, so no partial write can escape a
 * cancel. Both phases share one internal collector, so the preview can never
 * describe a change the apply would not make.
 *
 * ## Contradictions with the P2.9 brief, recorded rather than implemented around
 *
 * - The brief said `format-adapters/claude.ts`; the real path is
 *   `plugins/format-adapters/claude.ts`.
 * - The brief said `~/.claude` is "already read as a native capability layer".
 *   Measured on HEAD: `buildNativeCapabilityInventory`'s GLOBAL scope reads
 *   `~/.nessy-agent` (`CONFIG_DIR`) and `~/.agents/skills`, NOT the user's home
 *   `~/.claude`; only the PROJECT scope reads a project-local `.claude/` when the
 *   cwd is trusted. So the user's home `~/.claude` is NOT already imported — this
 *   module is what reads it — but the READERS the brief pointed at are reused.
 * - Source scope WAS Claude Code only (`~/.claude` + `~/.claude.json`). P6.523
 *   added `~/.codex` as a second source, read by the same scan; Cursor and
 *   Gemini CLI stay deferred (Dev-13) and the reason is restated where the codex
 *   reader is defined, so the next reader does not re-open it blind.
 * - The original row scoped this to five kinds (instruction / permission / skill /
 *   mcp / hook) and this paragraph used to say Claude `agents/` and `commands/`
 *   were "deliberately out of scope". P6.442 added them, because that is where a
 *   switching user's own customisation lives, and the sentence is replaced rather
 *   than left contradicting the code beneath it. P6.521 and P6.520 took it to
 *   nine: project memories, and the one interactive setting with a surface here.
 * - **Chats are the one thing deliberately NOT carried**, and the reason is
 *   recorded on {@link collectMemories} rather than left as an absence: a
 *   transcript would have to be rewritten into this product's own session store,
 *   and no such conversion exists on any of the three runtimes. When the
 *   project directory holds transcripts the user is told so, so the omission is
 *   not read as a defect.
 *
 * ## Where the two new kinds LAND, measured rather than assumed (P6.442)
 *
 * Neither has a saver, so both are a `cpSync` exactly as the skill kind is. The
 * destinations are the READ conventions that exist at HEAD, and each was read
 * out of its own loader rather than chosen:
 *
 * - **Agents → the workspace ROOT, as `<name>.md`.** `readUserAgentDefinitions`
 *   (`agents/definitions.ts`) is called with the workspace root and reads
 *   markdown definitions from that directory itself. `<ws>/.nessy-agent/agents`
 *   is NOT a workspace-scope convention — that path is read from the PROJECT
 *   root and only when the project is trusted — so writing there would produce a
 *   file nothing loads.
 * - **Commands → `<ws>/.nessy-agent/commands/<name>.md`.** The row's own native
 *   clause said the `commands/` target "is unnamed in our tree; skills are the
 *   nearest home". **That is REFUTED**: `slash-commands/custom-commands.ts`'s
 *   `COMMAND_DIRS` names `<root>/.nessy-agent/commands` and
 *   `<root>/.agents/commands`, and its `uniqueSearchRoots` includes the
 *   workspace root. The target exists; commands are not filed as skills.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import {
  loadRawWorkspacePermissions,
  parsePermissionsJson,
  saveWorkspacePermissions,
} from '../agent/permissions-config.ts';
import { NESSY_PERMISSION_DSL_VERSION } from '../agent/pi-harness/permission-dsl.ts';
import { scanMemoryImports, stripBlockHtmlComments } from '../agent/memory/memory-imports.ts';
import { AGENTS_OVERRIDE_INSTRUCTION_FILE, agentsMdSupersededIn } from './instruction-files.ts';
import { parseHooksConfigContent } from '../automations/hooks-config.ts';
import type { AgentEvent, AutomationMatcher, AutomationsConfig } from '../automations/types.ts';
import { loadStoredConfig, setSpellCheck } from '../config/storage.ts';
import { saveSourceConfig, sourceExists } from '../sources/storage.ts';
import type { FolderSourceConfig, McpSourceConfig, McpTransport } from '../sources/types.ts';
import { getWorkspaceSkillsPath, getWorkspaceSourcesPath } from '../workspaces/storage.ts';
import { mcpServerRecords, skillRecords } from './native-sources.ts';
import { readUserAgentDefinitions } from '../agents/definitions.ts';
import { isInstructionFileName } from './instruction-files.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts';
import type { CapabilityScopeRef, McpConfigSkip } from './types.ts';

/** The artifact kinds a Claude Code setup import covers (nine since P6.521). */
export type ClaudeImportKind =
  | 'instruction' | 'permission' | 'skill' | 'mcp' | 'hook' | 'agent' | 'command'
  /**
   * P6.521 — the auto-memory files Claude keeps per project. Listed PER FILE in
   * the preview rather than behind one badge, because a memory file can carry
   * material the user did not mean to move and a single "Memories" row would
   * hide which.
   */
  | 'memory'
  /**
   * P6.520 — the one family that does NOT land in the workspace. A Claude
   * `settings.json` carries interactive-mode keys, and exactly one of them has a
   * built surface here; it is an installation-global preference, so the preview
   * row says so and the user confirms it like any other change.
   */
  | 'setting';

/**
 * What the import would do to one target.
 * - `create`  — a new file/directory that does not exist yet.
 * - `merge`   — additive, idempotent write into an existing target (permissions,
 *   hooks, the AGENTS.md import block).
 * - `conflict`— a write this import refuses to make, left untouched and reported
 *   so the user can resolve it. TWO shapes carry it, and the second is why this
 *   line no longer reads "a `create` whose target already exists" (P3.242): a
 *   `create` whose target already exists, AND a `merge` whose target would be
 *   written but never READ, because another file supersedes it.
 */
export type ClaudeImportAction = 'create' | 'merge' | 'conflict';

export interface ClaudeImportChange {
  kind: ClaudeImportKind;
  action: ClaudeImportAction;
  /** Human-facing name (skill slug, MCP server name, "Permission rules", …). */
  name: string;
  /** Workspace-relative target path the write lands on. */
  target: string;
  /** One-line detail for the preview (rule count, transport, event names, …). */
  detail?: string;
  /**
   * P6.654 — this change was written, and the thing it wrote CANNOT RUN until a
   * person supplies a credential. Present only where that is true; never `false`.
   *
   * A machine-readable flag and not a substring of {@link detail}: the detail is
   * one prose sentence for the preview, and a surface that had to match prose to
   * find the servers needing a key would break on the next wording change.
   *
   * **Deliberately NOT `connectionStatus: 'needs_auth'` on the written source.**
   * `source-oauth.ts` reads that status as an OAuth flow waiting to be resumed,
   * so stamping it on a server whose only gap is an unset environment variable
   * would offer the user a Connect button that runs no OAuth and fixes nothing.
   * The fact belongs to the IMPORT, so it rides the import's own result.
   */
  needsAuth?: true;
}

export interface ClaudeSetupImportOptions {
  /** Absolute workspace root the import writes into (the active workspace). */
  workspaceRootPath: string;
  /** Home directory; defaults to `os.homedir()`. Test seam. */
  homeDir?: string;
  /** Claude config dir; defaults to `<homeDir>/.claude`. Test seam. */
  claudeDir?: string;
  /** Claude user JSON (holds user-scope `mcpServers`); defaults to `<homeDir>/.claude.json`. */
  claudeJsonPath?: string;
  /**
   * P6.523 — the codex home, the SECOND foreign format this importer reads.
   * Defaults to `CODEX_HOME` when set, else `<homeDir>/.codex`. Test seam.
   */
  codexDir?: string;
}

export interface ClaudeSetupImportPlan {
  /** The Claude config dir that was read. */
  claudeDir: string;
  /** The workspace root the changes target. */
  workspaceRootPath: string;
  /** Every change, in a stable kind-then-name order. */
  changes: ClaudeImportChange[];
  /** Non-fatal problems surfaced during the read (malformed files, skips). */
  warnings: string[];
  /** True when there is nothing importable at all (drives the empty-state UI). */
  empty: boolean;
}

export interface ClaudeSetupImportResult {
  /** Changes actually written (create + merge). */
  applied: ClaudeImportChange[];
  /** Changes left untouched (conflicts). */
  skipped: ClaudeImportChange[];
  /** Errors hit while writing an individual change; never aborts the others. */
  errors: string[];
}

// The delimiters of the merge-managed AGENTS.md region. Re-importing replaces the
// region rather than appending a second copy, which is what makes it idempotent.
const AGENTS_IMPORT_BEGIN = '<!-- nessy:claude-import:begin -->';
const AGENTS_IMPORT_END = '<!-- nessy:claude-import:end -->';

// ---------------------------------------------------------------------------
// Internal collection — the ONE source of truth both phases share.
// ---------------------------------------------------------------------------

interface PermissionItem {
  rules: Array<{ id: string; action: 'allow' | 'ask' | 'deny'; match: unknown }>;
}
interface HookItem {
  automations: AutomationsConfig['automations'];
  events: string[];
}
interface SkillItem {
  slug: string;
  sourceDir: string;
}
interface McpItem {
  name: string;
  slug: string;
  config: McpSourceConfig;
  /** `env`/`headers` were declared but could not be carried; import disabled. */
  needsReview: boolean;
}
interface InstructionItem {
  content: string;
}
/**
 * P6.520 — one accepted interactive-mode key, resolved against what is already
 * stored. `action` is decided at collection time because it needs the stored
 * value, and the apply pass must not re-decide it.
 */
interface SettingItem {
  /** The Claude key, verbatim, so the preview names what the user wrote. */
  claudeKey: string;
  /** The Nessy surface it lands on, for the preview's target line. */
  target: string;
  enabled: boolean;
  action: ClaudeImportAction;
  detail: string;
}
/**
 * P6.442 — one markdown file, for the two kinds that are a straight copy.
 * `fileName` is what lands at the destination: our own readers derive the agent
 * name and the command name from the file name, so renaming it here would
 * rename the capability.
 */
interface MarkdownFileItem {
  fileName: string;
  sourcePath: string;
}

interface CollectedImport {
  instruction?: InstructionItem;
  /** Which file supplied the instruction block — `CLAUDE.md`, or a codex one. */
  instructionSourceName?: string;
  /** Its absolute path, so the receipt hashes the file that actually supplied it. */
  instructionSourcePath?: string;
  permission?: PermissionItem;
  hook?: HookItem;
  skills: SkillItem[];
  mcp: McpItem[];
  agents: MarkdownFileItem[];
  commands: MarkdownFileItem[];
  memories: MarkdownFileItem[];
  settings: SettingItem[];
  warnings: string[];
}

/**
 * `<claude config dir>`, in the order an explicit answer beats an ambient one —
 * the same precedence, for the same reason, as {@link resolveCodexDir}.
 *
 * `CLAUDE_CONFIG_DIR` is honoured because the runtime honours it.
 * `env-vars.md#variables`, the `CLAUDE_CONFIG_DIR` row, verbatim: *"Override the
 * configuration directory (default: `~/.claude`). All settings, session history,
 * and plugins are stored under this path."* So a user who moved their config
 * directory has their Claude Code setup THERE, and an importer hard-wired to
 * `~/.claude` reads an empty directory and reports an honest-looking nothing.
 * `agent/memory/instruction-excludes.ts`'s `defaultClaudeConfigDirectory` reads
 * the same variable for the same reason; this one is not exported because the
 * precedence differs — that resolver has no `homeDir` seam to defer to.
 *
 * It sits BELOW an explicitly supplied `claudeDir` or `homeDir` on purpose: a
 * caller that names one has answered the question, and letting an ambient
 * variable overrule it would make the same call read a different directory on
 * different machines — including under test, where it would reach the
 * developer's real setup.
 *
 * **The residue, stated rather than hidden** (the same one
 * `instruction-excludes.ts` records): a Workspace redirects the CHILD's config
 * dir — `agent/options.ts` assigns `CLAUDE_CONFIG_DIR` into the child env object,
 * never into our own `process.env` — so this reads the USER's setting and not the
 * per-Workspace one.
 *
 * `fromConfigDirEnv` is what makes P6.1051's pairing possible at all: the project
 * directory name may only be honoured when the root came from the environment
 * too. See {@link resolveClaudeProjectDirNameOverride}.
 */
function resolveDirs(options: ClaudeSetupImportOptions): {
  claudeDir: string;
  claudeJsonPath: string;
  /** True only when `claudeDir` was taken from `CLAUDE_CONFIG_DIR`. */
  fromConfigDirEnv: boolean;
} {
  const home = options.homeDir ?? homedir();
  const claudeJsonPath = options.claudeJsonPath ?? join(home, '.claude.json');
  if (options.claudeDir) return { claudeDir: options.claudeDir, claudeJsonPath, fromConfigDirEnv: false };
  if (options.homeDir) return { claudeDir: join(home, '.claude'), claudeJsonPath, fromConfigDirEnv: false };
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv) return { claudeDir: fromEnv, claudeJsonPath, fromConfigDirEnv: true };
  return { claudeDir: join(home, '.claude'), claudeJsonPath, fromConfigDirEnv: false };
}

/**
 * The page's second rule for `CLAUDE_CODE_PROJECT_DIR_NAME`, verbatim
 * (`sessions.md#name-the-project-directory-yourself`): *"**Use 1-64 letters,
 * digits, hyphens, or underscores**: don't use a Windows device name such as
 * `con`. Claude Code ignores any other value and uses the derived name."*
 */
const CLAUDE_PROJECT_DIR_NAME_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The Windows reserved device names, which the page names by EXAMPLE only
 * (*"such as `con`"*) rather than enumerating.
 *
 * Enumerated here because the rule is load-bearing in one direction: the runtime
 * ignores such a value and writes under the DERIVED name, so honouring it would
 * send this importer looking in a directory the runtime never wrote to — the
 * exact failure the pairing below exists to prevent, one rule further in. The
 * list is the classic MS-DOS set every Win32 path API still reserves; a name the
 * runtime accepts and this refuses costs a fallback to the derived name, which is
 * what a user who never set the variable already gets.
 */
const WINDOWS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * `CLAUDE_CODE_PROJECT_DIR_NAME`, honoured only TOGETHER with `CLAUDE_CONFIG_DIR`
 * — P6.1051, and the pairing is the vendor's own rule rather than caution.
 *
 * `sessions.md#name-the-project-directory-yourself`, the first of its three
 * rules, verbatim: *"**Set `CLAUDE_CONFIG_DIR` too**: the name doesn't vary with
 * the working directory, so under the default `~/.claude` it would merge every
 * project's transcripts and auto memory into one directory. Claude Code ignores
 * `CLAUDE_CODE_PROJECT_DIR_NAME` when `CLAUDE_CONFIG_DIR` is unset."* The
 * `env-vars.md` row says it twice over — *"Set together with `CLAUDE_CONFIG_DIR`"*
 * and *"Claude Code ignores this variable when `CLAUDE_CONFIG_DIR` is unset"*.
 *
 * So the two land together or neither does, and `fromConfigDirEnv` is the
 * condition: reading the name against a root this importer resolved some other
 * way would point it at a directory the runtime never wrote to and turn an
 * honest miss into a confident one.
 *
 * Also verbatim, the third rule — *"Set it in the shell environment that starts
 * `claude`… so an `env` block in a settings file can't set it"* — which is why
 * this reads `process.env` and no settings layer. It is real at the vendored
 * `2.1.247` (6 occurrences in the native binary, 0 at `2.1.233`; control
 * `nessyNotARealSdkKey` 0) and the page dates it *"Requires Claude Code v2.1.234
 * or later"*.
 */
function resolveClaudeProjectDirNameOverride(fromConfigDirEnv: boolean): string | undefined {
  if (!fromConfigDirEnv) return undefined;
  const raw = process.env.CLAUDE_CODE_PROJECT_DIR_NAME?.trim();
  if (!raw || !CLAUDE_PROJECT_DIR_NAME_SHAPE.test(raw)) return undefined;
  return WINDOWS_DEVICE_NAMES.has(raw.toLowerCase()) ? undefined : raw;
}

/** Lowercase, non-alphanumeric → single dash; the deterministic base slug used
 * for conflict detection (so a re-import of the same server name is a conflict,
 * never a `server-2` duplicate). */
function baseSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'source';
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function collectInstruction(claudeDir: string, warnings: string[]): InstructionItem | undefined {
  const path = join(claudeDir, 'CLAUDE.md');
  if (!existsSync(path)) return undefined;
  let content: string;
  try {
    content = readFileSync(path, 'utf-8').trim();
  } catch (error) {
    warnings.push(`Could not read ${path}: ${errText(error)}`);
    return undefined;
  }
  if (!content) return undefined;
  // The body is copied VERBATIM, so a Claude `@path` import inside it keeps
  // pointing at a file relative to `~/.claude` and reads as a dangling
  // reference from the workspace. The files are deliberately not copied — an
  // import can name anything on disk, and following it would turn one import
  // into an unbounded file copy — so each token is NAMED instead of silently
  // shipping a reference that resolves to nothing.
  //
  // Recognised with the runtime's OWN scanner, not a private regex, so what is
  // reported here and what the composer treats as an import cannot drift: a
  // token in a code span or fenced block is not an import, and a commented-out
  // token never reaches the model.
  const tokens = scanMemoryImports(stripBlockHtmlComments(content));
  for (const token of new Set(tokens.map(t => t.path))) {
    warnings.push(
      `Instruction file references "@${token}", which is not copied; the reference will not resolve `
      + 'from this workspace until you add that file or edit the line.',
    );
  }
  return { content };
}

/**
 * The absolute-anchored spelling of a `/`-anchored (settings-source) pattern,
 * or `undefined` when it cannot be expressed as one.
 *
 * WHY THIS EXISTS — the defect it closes. `parsePermissionsJson` only KEEPS an
 * `anchor: 'source'` rule when it is given a `sourceRoot`
 * (`permissions-config.ts`: "the KEEP decision and the ANCHOR can never
 * disagree"), and the anchor is a COMPILE-TIME LAYER PROPERTY, not part of the
 * matcher. Our destination is a Nessy-format `permissions.json`, and that file's
 * read path never returns a `sourceRoot` — only the Claude branch does — so a
 * verbatim `anchor: 'source'` matcher written there throws
 * `invalid pathGlob source root` at compile. The compiler catches per LAYER, so
 * ONE such rule sets `invalidSource` and turns the whole workspace policy into
 * deny-everything, persisted to disk, with a co-resident allow destroyed
 * alongside it. Measured before this fix: `deny:['Read(/secrets/**)'] +
 * allow:['Bash(ls:*)']` compiled 0 rules and evaluated `Bash(ls)` to `deny`
 * (`ruleId: 'invalid-policy'`).
 *
 * So the anchor is resolved AT IMPORT, while `claudeDir` — the real directory
 * the rule was anchored at — is still in hand. `anchor: 'absolute'` resolves
 * against the filesystem root (`resolveAnchorBase` returns `sep`) and stores the
 * path WITHOUT its leading separator, which is the shape a `//`-anchored Claude
 * rule already imports as. The rule keeps meaning exactly the same set of paths.
 *
 * The in-repo precedent (the managed-policy path in `permissions-config.ts`)
 * DROPS source-anchored rules, but it has no directory to resolve against — a
 * delivered policy has no file. We do, so resolving preserves the user's rule
 * instead of discarding it; dropping is the fallback, never the default.
 *
 * Returns `undefined` when the root is not POSIX-shaped (a Windows `C:\\...`
 * root has no `absolute`-anchored representation, because the compiler rejects
 * any pattern containing a backslash) — the caller then drops the rule WITH a
 * warning rather than writing a policy-bricking matcher.
 */
function absolutePatternFromSourceAnchor(
  claudeDir: string,
  /** The matcher kind — `pathGlob` floats a bare literal, `cdPath` does not. */
  kind: unknown,
  pattern: string,
): { pattern: string } | { drop: 'unrepresentable-root' | 'parent-segment' } {
  if (!claudeDir.startsWith('/')) return { drop: 'unrepresentable-root' };

  // GUARD B — a `..` SEGMENT, which resolving would silently widen.
  //
  // `posix.join` normalizes `..` away, and the two sides then disagree:
  // the matcher rejects any value whose `relative()` from the base starts with
  // `..` (both the pathGlob and the cdPath call sites do this), and a clean
  // `relative()` result never contains a `..` component in the middle either. So
  // on the Claude side a pattern with a `..` segment matches NOTHING REAL —
  // measured: `a/../b` matches neither `b` nor `a/b`. Resolving it would invent
  // matches that the rule never had:
  //   allow Read(/../evil/**)   claude — → import ALLOW   (widening)
  //   allow Read(/../../../**)  claude — → import ALLOW over everything above
  //                                        the Claude dir, up to a bare `**`
  //                                        (a filesystem-wide read grant) when
  //                                        the directory is shallow enough
  //   allow Read(/a/../b)       claude — → import ALLOW   (widening WITHOUT
  //                                        escaping the directory at all)
  // The last one is why this tests the SEGMENTS rather than whether the join
  // escapes `claudeDir`: an escape check alone lets `a/../b` through.
  //
  // Dropping is exactly faithful here precisely BECAUSE the Claude side matches
  // nothing: no allow is lost and no deny loses protection it actually had. A
  // `.` segment is NOT dropped — measured faithful, both sides treat it as a
  // no-op (`./b` matches `b` on the Claude side, and `join` produces the same).
  if (pattern.split('/').includes('..')) return { drop: 'parent-segment' };

  // GUARD A — keep the gitignore depth float a bare literal already has.
  //
  // `matchGitignoreGlob` prepends `**` to a pattern with no `/` and no `*?`,
  // stating the equivalence in its own docstring: "Bare filenames follow
  // gitignore semantics and match at any depth, so `Read(.env)` and
  // `Read(**​/.env)` are equivalent." Resolving introduces slashes, which kills
  // that float and NARROWS the rule — measured on `deny: ['Read(/.env)']`,
  // `<claudeDir>/sub/.env` went from `deny` to no verdict. A `Read(/.env)`-shaped
  // deny is the commonest spelling in a real `.claude` deny list, so this is the
  // likeliest class to bite. Writing the float out explicitly as `**/<name>` is
  // that same documented equivalence, and `**` matches ZERO segments (measured),
  // so the depth-0 case keeps matching too.
  //
  // `pathGlob` ONLY. `Cd` passes `bareLiteralFloat: false` because its patterns
  // are "anchored to the whole directory path rather than gitignore-style"
  // (permissions.md § Cd) — measured: `work` does not match `sub/work` there. So
  // floating a `cdPath` would ADD a float Claude does not have, trading this
  // narrowing for a widening.
  const floatsAtAnyDepth = kind === 'pathGlob'
    && !pattern.includes('/')
    && !/[*?]/.test(pattern);

  // POSIX join: the compiler rejects a pattern containing a backslash, so the
  // platform-native `join` must not decide the separator here.
  const joined = floatsAtAnyDepth
    ? posix.join(claudeDir, '**', pattern)
    : posix.join(claudeDir, pattern);
  if (!joined.startsWith('/')) return { drop: 'unrepresentable-root' };
  const relative = joined.slice(1);
  if (!relative || relative.includes('\\') || relative.includes('\0')) {
    return { drop: 'unrepresentable-root' };
  }
  return { pattern: relative };
}

/** Claude rule-string entries, per action, exactly as the settings file spells them. */
function claudeRuleEntries(claudeDir: string): Record<string, unknown[]> {
  const settings = readJsonObject(join(claudeDir, 'settings.json'));
  const block = settings?.permissions;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {};
  const out: Record<string, unknown[]> = {};
  for (const action of ['deny', 'ask', 'allow'] as const) {
    const entries = (block as Record<string, unknown>)[action];
    if (Array.isArray(entries)) out[action] = entries;
  }
  return out;
}

function collectPermissions(claudeDir: string, warnings: string[]): PermissionItem | undefined {
  const path = join(claudeDir, 'settings.json');
  if (!existsSync(path)) return undefined;
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (error) {
    warnings.push(`Could not read ${path}: ${errText(error)}`);
    return undefined;
  }
  // `parsePermissionsJson` recognizes a Claude settings file's `permissions`
  // block and compiles it into a `permissionDsl` source (the SAME path the
  // native project-`.claude/settings.json` layer takes). `sourceRoot` is the
  // dir so a `/`-anchored rule survives the reader's KEEP decision; the anchor
  // it keeps is then resolved below, before anything is written.
  const config = parsePermissionsJson(content, claudeDir);
  const document = config.permissionDsl?.document;
  if (!document || typeof document !== 'object') return undefined;
  const rawRules = (document as { rules?: unknown }).rules;
  if (!Array.isArray(rawRules)) return undefined;

  const kept = rawRules.filter((r): r is { id: string; action: 'allow' | 'ask' | 'deny'; match: unknown } =>
    !!r && typeof r === 'object'
    && ((r as { action?: unknown }).action === 'allow'
      || (r as { action?: unknown }).action === 'ask'
      || (r as { action?: unknown }).action === 'deny'));

  // Every entry the reader did NOT turn into a rule is named. The reader drops
  // an inert or unanchorable entry behind a `debug()` only, and a silently
  // dropped DENY is a protection loss the user cannot detect from a rule count
  // they have no way to cross-check. The reader ids rules
  // `claude-settings-<action>-<index>` where the index is the entry's position
  // in that action's array, which is what makes the surviving set invertible
  // back to the entries that did not survive.
  const survivingIds = new Set(kept.map(rule => rule.id));
  for (const [action, entries] of Object.entries(claudeRuleEntries(claudeDir))) {
    entries.forEach((entry, index) => {
      if (survivingIds.has(`claude-settings-${action}-${index}`)) return;
      const label = typeof entry === 'string' && entry.trim()
        ? `"${entry.trim()}"`
        : entry === '' || (typeof entry === 'string' && !entry.trim())
          ? '(blank)'
          : JSON.stringify(entry);
      warnings.push(
        `Permission rule ${action} ${label} could not be imported and was skipped; `
        + 'it names no tool this runtime knows, or it cannot be anchored.',
      );
    });
  }

  const rules: PermissionItem['rules'] = [];
  kept.forEach((rule, index) => {
    const match = rule.match;
    const anchor = match && typeof match === 'object'
      ? (match as { anchor?: unknown }).anchor
      : undefined;
    let resolved = match;
    if (anchor === 'source') {
      const source = match as { pattern?: unknown; kind?: unknown };
      const pattern = typeof source.pattern === 'string' ? source.pattern : undefined;
      const outcome = pattern === undefined
        ? { drop: 'unrepresentable-root' as const }
        : absolutePatternFromSourceAnchor(claudeDir, source.kind, pattern);
      if ('drop' in outcome) {
        // Dropped rather than written. Either the anchor cannot be expressed
        // (and an unresolvable source anchor is the exact matcher that bricks
        // the whole layer at compile), or resolving it would change what the
        // rule matches — see the two guards above.
        warnings.push(
          outcome.drop === 'parent-segment'
            ? `Permission rule ${rule.action} "${pattern}" reaches outside the Claude settings directory `
              + 'with "..", which matches nothing in Claude either, so the rule was skipped rather than '
              + 'imported as a broader grant.'
            : `Permission rule ${rule.action} "${pattern ?? '(unnamed)'}" is anchored at the Claude settings `
              + 'directory, which cannot be expressed as an absolute path here, so the rule was skipped.',
        );
        return;
      }
      resolved = { ...(match as Record<string, unknown>), pattern: outcome.pattern, anchor: 'absolute' };
    }
    // Re-id under an import-specific namespace so a re-import is idempotent by id
    // and never collides with a rule another writer added.
    rules.push({ id: `claude-import-${rule.action}-${index}`, action: rule.action, match: resolved });
  });
  return rules.length > 0 ? { rules } : undefined;
}

function collectHooks(claudeDir: string, warnings: string[]): HookItem | undefined {
  const settings = readJsonObject(join(claudeDir, 'settings.json'));
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return undefined;
  // Claude settings hooks are `{ Event: [{ matcher, hooks: [{type:'command', …}] }] }`.
  // Our automations reader wants `{ Event: [{ matcher, actions: [...] }] }`. The
  // rename of that inner list and the `matchMode:'claude'` tag that lived here
  // moved INTO the native reader (F1.898 — `adaptClaudeHookGroups` in
  // `automations/hooks-config.ts`, applied by `parseHooksConfig`), so a
  // hand-written `hooks.json` in Claude's shape and this import read one way,
  // a handler's `if` included (lifted onto the matcher there, no longer
  // stripped). The native validator still does the action and matcher parse.
  // What stays HERE is the one import-only leniency: an event whose value is
  // not a list is skipped, so it does not cost the import every other event.
  const adapted: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    // A group already carrying `actions`, or with no inner `hooks` list, is
    // handed over as written; the native reader decides it, as it does for
    // every other document.
    adapted[event] = entries;
  }
  const result = parseHooksConfigContent(JSON.stringify({ hooks: adapted }), 'Claude settings.json hooks');
  for (const error of result.errors) warnings.push(error);
  // C3.284 — the non-fatal notes moved from `errors` to `warnings` in
  // `parseHooksConfig` (an unemitted event, a Notification type with no
  // emitter). They are exactly the diagnostics an IMPORT has to show — the
  // hook is being carried over from Claude and will never run here — so this
  // surface reads both arrays and reports the same set it always did.
  for (const warning of result.warnings ?? []) warnings.push(warning);
  const events = Object.keys(result.config.automations);
  return events.length > 0 ? { automations: result.config.automations, events } : undefined;
}

function collectSkills(claudeDir: string): SkillItem[] {
  // Reuse the native skill reader on `~/.claude/skills` — the exact
  // `<dir>/<slug>/SKILL.md` layout it already reads for every other native skill
  // tier. (`normalizeClaudePluginBundle` is a plugin-BUNDLE reader and rejects
  // `~/.claude` on its manifest-id rule, so it is not the right seam here; the
  // native reader is what the `~/.claude`-style layers use.)
  const records = skillRecords(join(claudeDir, 'skills'), { kind: 'global' });
  return records
    .map(record => ({ slug: record.logicalName, sourceDir: record.sourcePath }))
    .filter(skill => existsSync(skill.sourceDir))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Server names in one Claude MCP config that declare `env` or `headers`.
 *
 * The native reader's identity type carries transport, url and argv and NOTHING
 * else, so an `env` block or a `headers` block is config we provably drop. This
 * is a PRESENCE check on the already-parsed document, not a second parser: the
 * server's transport identity still comes from `mcpServerRecords` alone. Only
 * declarations we can see are reported — a server whose token Claude keeps
 * outside the file is not knowable here, and is not claimed to be.
 */
function mcpServersWithDroppedConfig(path: string): Set<string> {
  const out = new Set<string>();
  const parsed = readJsonObject(path);
  const servers = parsed?.mcpServers;
  const map = servers && typeof servers === 'object' && !Array.isArray(servers)
    ? servers as Record<string, unknown>
    : undefined;
  if (!map) return out;
  for (const [name, raw] of Object.entries(map)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as { env?: unknown; headers?: unknown };
    const nonEmpty = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
      && Object.keys(v as Record<string, unknown>).length > 0;
    if (nonEmpty(entry.env) || nonEmpty(entry.headers)) out.add(name);
  }
  return out;
}

function collectMcp(claudeDir: string, claudeJsonPath: string, warnings: string[]): McpItem[] {
  // Read every declared user-scope MCP server through the native `{mcpServers}`
  // reader. `~/.claude.json` holds user servers at its top level; a user-level
  // `~/.claude/.mcp.json` is read too. First declaration of a name wins.
  const scope: CapabilityScopeRef = { kind: 'global' };
  const seen = new Set<string>();
  const items: McpItem[] = [];
  for (const path of [claudeJsonPath, join(claudeDir, '.mcp.json')]) {
    const skips: McpConfigSkip[] = [];
    const records = mcpServerRecords(path, scope, '', undefined, skips);
    for (const skip of skips) warnings.push(skip.message);
    const droppedConfig = mcpServersWithDroppedConfig(path);
    for (const record of records) {
      const name = record.logicalName;
      if (seen.has(name)) continue;
      const identity = record.mcpServerIdentity;
      const config = identity ? mcpConfigFromIdentity(identity) : undefined;
      if (!config) {
        warnings.push(`MCP server "${name}" has no usable stdio command or http/sse url; skipped.`);
        continue;
      }
      seen.add(name);
      // A server whose `env`/`headers` we could not carry is imported DISABLED
      // rather than enabled-and-dead: an enabled source that cannot connect
      // looks like a product defect, while a disabled one states the situation
      // and is one click from working once the user supplies the value.
      const needsReview = droppedConfig.has(name);
      if (needsReview) {
        warnings.push(
          `MCP server "${name}" declares environment variables or headers, which are not carried over. `
          + 'It was imported disabled — add the values in Sources, then enable it.',
        );
      }
      items.push({ name, slug: baseSlug(name), config, needsReview });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function mcpConfigFromIdentity(
  identity: NonNullable<import('./types.ts').NativeCapabilitySourceRecord['mcpServerIdentity']>,
): McpSourceConfig | undefined {
  const command = identity.command;
  // `command` is the full argv `[command, ...args]`. The native reader's
  // transport union is wider than a source's (it can carry `ws`), so it is
  // narrowed to our three here; an undeclared transport is inferred from what is
  // present.
  const declared = identity.transport;
  const transport: McpTransport | undefined =
    declared === 'stdio' || declared === 'http' || declared === 'sse'
      ? declared
      : command && command.length > 0 ? 'stdio' : identity.url ? 'http' : undefined;
  if (transport === 'stdio') {
    if (!command || command.length === 0) return undefined;
    const [executable, ...args] = command;
    return { transport: 'stdio', command: executable, ...(args.length > 0 ? { args } : {}) };
  }
  if (transport === 'http' || transport === 'sse') {
    if (!identity.url) return undefined;
    // `authType: 'none'` satisfies the source validator's "(url + authType) for
    // HTTP/SSE" requirement; the imported endpoint carries no credential until
    // the user wires one up in the Sources UI.
    return { transport, url: identity.url, authType: 'none' };
  }
  return undefined;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `.md` files in one `~/.claude` subdirectory, in a stable order.
 *
 * `isInstructionFileName` is applied for the same reason the agent loader
 * applies it: `CLAUDE.md` and `AGENTS.md` sitting in one of these directories
 * are instruction files, and the instruction kind already carries them.
 */
function markdownFilesIn(dir: string, skip: (path: string) => boolean): MarkdownFileItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile()
      && entry.name.toLowerCase().endsWith('.md')
      && !isInstructionFileName(entry.name))
    .map(entry => ({ fileName: entry.name, sourcePath: join(dir, entry.name) }))
    .filter(item => !skip(item.sourcePath))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/**
 * P6.442 — `~/.claude/agents/*.md`, validated by OUR OWN loader.
 *
 * `readUserAgentDefinitions` pointed at that directory is the same reader that
 * will load the file once it lands, so a definition it refuses is refused HERE
 * rather than copied and then silently ignored — the module's no-new-parser rule
 * applied to a kind whose parse can fail. The failure callback carries the FILE
 * PATH, which is what makes a per-file skip possible at all.
 */
function collectAgents(claudeDir: string, warnings: string[]): MarkdownFileItem[] {
  const dir = join(claudeDir, 'agents');
  if (!existsSync(dir)) return [];
  const unreadable = new Set<string>();
  try {
    readUserAgentDefinitions(dir, failure => {
      unreadable.add(failure.file);
      warnings.push(`Claude agent "${basename(failure.file)}" was skipped: ${failure.reason}`);
    });
  } catch (error) {
    warnings.push(`Claude agents could not be read: ${errText(error)}`);
    return [];
  }
  return markdownFilesIn(dir, path => unreadable.has(path));
}

/**
 * P6.442 — `~/.claude/commands/*.md`.
 *
 * No validating reader to reuse: `listCustomSlashCommands` searches fixed
 * relative paths under the workspace and cannot be pointed at `~/.claude`, and
 * its filename rule normalises rather than refuses. So the file is copied and
 * the same normalisation happens when it is read, which is the behaviour a user
 * who put the file there already gets from Claude.
 */
function collectCommands(claudeDir: string): MarkdownFileItem[] {
  return markdownFilesIn(join(claudeDir, 'commands'), () => false);
}


// ---------------------------------------------------------------------------
// The SECOND foreign format: `~/.codex` (P6.523)
// ---------------------------------------------------------------------------

/**
 * Reading a codex setup, and the exact boundary of what is read (P6.523,
 * Q-den 56 = option 2: add `~/.codex` only).
 *
 * ## Why codex and only codex
 *
 * Dev-13 deferred every foreign format beyond Claude Code — *"Import sources
 * beyond Claude Code (Cursor, Cowork): later"* — and the deferral is kept for
 * Cursor and Gemini CLI **for a reason that is restated here so the next reader
 * does not re-open it blind**: neither could be evidenced from anything but a
 * documentation page, and a page is the WEAK tier. Codex is the one foreign
 * format this product can check against open source AND a binary it ships.
 *
 * ## Pinned, and honest about the pin
 *
 * Every shape below was read from `github.com/openai/codex` at **`rust-v0.148.0`**
 * — the tag our vendored `codex-app-server` is built from (P3.224). Upstream is
 * already four minors ahead at `rust-v0.152.1`; moving to it is P3.283's
 * decision, not this reader's, and until it lands a codex setup written by a
 * NEWER codex may carry keys this reader does not know. Such a key is diagnosed
 * by name, never dropped.
 *
 * ## What is read
 *
 * - **Instructions** — `<codex home>/AGENTS.override.md`, then
 *   `<codex home>/AGENTS.md`, first non-empty wins. Measured, not assumed:
 *   `codex-rs/codex-home/src/instructions/mod.rs` loops
 *   `[LOCAL_AGENTS_MD_FILENAME, DEFAULT_AGENTS_MD_FILENAME]` and returns on the
 *   first file whose trimmed contents are non-empty.
 * - **MCP servers** — the `[mcp_servers.<name>]` tables of
 *   `<codex home>/config.toml`. `codex-rs/config/src/mcp_types.rs` at the same
 *   tag types the transport as an untagged union of `Stdio { command, args, env,
 *   env_vars, cwd }` and `StreamableHttp { url, bearer_token_env_var,
 *   http_headers, env_http_headers, http_headers_helper }`, with `enabled`
 *   defaulting to true on the server itself.
 *
 * ## What is NOT read, each with its reason
 *
 * - **Custom prompts and skills.** The codex repository's own `docs/skills.md`
 *   and `docs/slash_commands.md` at this tag are two-line stubs pointing at
 *   `developers.openai.com`, and the vendored app-server protocol carries no
 *   custom-prompt type at all — so the on-disk directory could only have been
 *   taken from a page. For codex that is the weak tier, which makes it a
 *   hypothesis about the binary rather than a measurement, and this reader does
 *   not ship hypotheses. It is a null recorded, not an absence assumed.
 * - **Everything else in `config.toml`** — model, provider, sandbox, approval
 *   policy, hooks. These are runtime posture, not portable artifacts, and
 *   several of them are decisions this product makes for the user.
 *
 * ## Collision rule, stated
 *
 * One workspace, two foreign homes. Where both declare the same thing, **the
 * Claude Code setup wins and the codex one is named as skipped** — not because
 * it is better, but because it is the import that already existed and silently
 * changing which side wins would move a user's setup under them. An instruction
 * file is the same: `~/.claude/CLAUDE.md` supplies the managed block when it is
 * present, and a codex user with no Claude setup gets theirs.
 */
const CODEX_INSTRUCTION_FILES = Object.freeze(['AGENTS.override.md', 'AGENTS.md']);

/**
 * `<codex home>`, in the order an explicit answer beats an ambient one:
 * `codexDir`, then `<homeDir>/.codex` when a home was named, then `CODEX_HOME`,
 * then `<os home>/.codex`.
 *
 * `CODEX_HOME` is honoured because the binary honours it — measured in the
 * shipped binary (P3.30's scan counted it 34 times) and set by our own
 * `runtime-manager` for the codex child. It sits BELOW an explicitly supplied
 * `homeDir` on purpose: a caller that names a home has answered the question,
 * and letting an ambient variable overrule it would make the same call read a
 * different directory on different machines — including under test, where it
 * would reach the developer's real setup.
 */
function resolveCodexDir(options: ClaudeSetupImportOptions): string {
  if (options.codexDir) return options.codexDir;
  if (options.homeDir) return join(options.homeDir, '.codex');
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), '.codex');
}

/**
 * The `[section]` tables of a TOML file, as raw key/value lines.
 *
 * A deliberately narrow reader, and narrow is the point: it recognises string,
 * boolean, string-array and inline-table values, and it DIAGNOSES every line it
 * cannot represent with the file and line number. A key it cannot read is never
 * silently dropped, which is the property that lets a reader pinned to one codex
 * tag stay honest when it meets a file written by a newer one.
 */
function readTomlSections(content: string, sourceName: string, warnings: string[]): Map<string, Record<string, unknown>> {
  const sections = new Map<string, Record<string, unknown>>();
  let current: Record<string, unknown> | undefined;
  let currentName = '';
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      currentName = table[1]!.trim();
      current = sections.get(currentName) ?? {};
      sections.set(currentName, current);
      continue;
    }
    const keyValue = /^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/.exec(line);
    if (!keyValue || !current) {
      warnings.push(`${sourceName}:${index + 1}: this line could not be read and was ignored.`);
      continue;
    }
    const key = keyValue[1]!.replace(/^"|"$/g, '');
    const value = readTomlValue(keyValue[2]!);
    if (value === undefined) {
      warnings.push(`${sourceName}:${index + 1}: the value of "${key}" in [${currentName}] is a TOML shape this importer does not read; it was ignored.`);
      continue;
    }
    current[key] = value;
  }
  return sections;
}

function stripTomlComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== '\\') inString = !inString;
    if (line[i] === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

/** `undefined` means "a shape this reader does not represent" — never "empty". */
function readTomlValue(raw: string): unknown {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    const body = value.slice(1, -1).trim();
    if (!body) return [];
    const parts = body.split(',').map(part => part.trim()).filter(Boolean);
    const strings = parts
      .filter(part => part.startsWith('"') && part.endsWith('"'))
      .map(part => part.slice(1, -1));
    return strings.length === parts.length ? strings : undefined;
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const out: Record<string, string> = {};
    const body = value.slice(1, -1).trim();
    if (!body) return out;
    for (const entry of body.split(',')) {
      const pair = /^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*"([^"]*)"\s*$/.exec(entry);
      if (!pair) return undefined;
      out[pair[1]!.replace(/^"|"$/g, '')] = pair[2]!;
    }
    return out;
  }
  return undefined;
}

/**
 * The instruction file a codex setup supplies, or `undefined`.
 *
 * The order and the non-empty rule are the binary's own, read from
 * `codex-rs/codex-home/src/instructions/mod.rs` at `rust-v0.150.1`.
 */
function collectCodexInstruction(codexDir: string, warnings: string[]): { fileName: string; content: string } | undefined {
  for (const fileName of CODEX_INSTRUCTION_FILES) {
    const path = join(codexDir, fileName);
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (error) {
      warnings.push(`Could not read ${path}: ${errText(error)}`);
      continue;
    }
    // "if !trimmed.is_empty()" — an empty override falls through to AGENTS.md.
    if (content.trim().length === 0) continue;
    return { fileName, content };
  }
  return undefined;
}

/**
 * The `[mcp_servers.<name>]` tables of a codex `config.toml`, as importable
 * sources.
 *
 * `env`, `http_headers` and every environment-variable indirection
 * (`env_vars`, `bearer_token_env_var`, `env_http_headers`,
 * `http_headers_helper`) are NOT carried, for the same reason the Claude path
 * does not carry them: the value they name lives in the user's shell, not in the
 * file, so copying the key without the value produces a source that cannot
 * connect. Such a server is imported DISABLED and says why — the identical
 * treatment its Claude sibling gets.
 */
function collectCodexMcp(codexDir: string, taken: ReadonlySet<string>, warnings: string[]): McpItem[] {
  const path = join(codexDir, 'config.toml');
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (error) {
    warnings.push(`Could not read ${path}: ${errText(error)}`);
    return [];
  }
  const sections = readTomlSections(content, path, warnings);
  const items: McpItem[] = [];
  for (const [sectionName, values] of sections) {
    const match = /^mcp_servers\.(.+)$/.exec(sectionName);
    if (!match) continue;
    // A sub-table (`[mcp_servers.x.env]`) is not a server; its parent is.
    const name = match[1]!.replace(/^"|"$/g, '');
    if (name.includes('.')) continue;
    if (values.enabled === false) continue; // codex would skip it too
    if (taken.has(name)) {
      warnings.push(
        `codex MCP server "${name}" was NOT imported: your Claude Code setup declares a server with the `
        + 'same name and it was imported instead. Rename one of them and scan again to bring both across.',
      );
      continue;
    }

    const url = typeof values.url === 'string' ? values.url : undefined;
    const command = typeof values.command === 'string' ? values.command : undefined;
    let config: McpSourceConfig | undefined;
    if (command) {
      const args = Array.isArray(values.args) ? values.args.filter((a): a is string => typeof a === 'string') : [];
      config = { transport: 'stdio', command, args };
    } else if (url) {
      config = { transport: 'http', url };
    }
    if (!config) {
      warnings.push(`codex MCP server "${name}" has no usable command or url; skipped.`);
      continue;
    }
    // Every shape whose real value lives outside the file.
    const uncarried = ['env', 'env_vars', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'http_headers_helper']
      .filter(key => values[key] !== undefined
        || sections.has(`mcp_servers.${name}.${key}`)
        || sections.has(`mcp_servers."${name}".${key}`));
    if (uncarried.length > 0) {
      warnings.push(
        `codex MCP server "${name}" declares ${uncarried.join(', ')}, whose values live in your shell and were `
        + 'not carried over. It was imported disabled — add the values in Sources, then enable it.',
      );
    }
    items.push({ name, slug: baseSlug(name), config, needsReview: uncarried.length > 0 });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The `<project>` directory name Claude Code derives from a working directory.
 *
 * `sessions.md` § Where sessions are stored, verbatim: *"Claude Code stores
 * transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`,
 * where `<project>` is your working directory path with non-alphanumeric
 * characters replaced by `-`. For a working directory whose converted name
 * exceeds 200 characters, Claude Code truncates the name to 200 characters and
 * appends a hash of the full path, so the directory name stays within filesystem
 * limits."*
 *
 * The substitution is documented and implemented. **The hash is NOT documented**,
 * so it is not invented here: over 200 characters this returns the truncated
 * PREFIX and {@link findClaudeProjectDir} matches any directory that starts with
 * it. That is the honest reading — a prefix match can in principle hit a sibling
 * whose path shares its first 200 characters, and the resolver refuses rather
 * than guesses when more than one matches.
 */
function claudeProjectDirName(workingDirectory: string): string {
  const converted = workingDirectory.replace(/[^a-zA-Z0-9]/g, '-');
  return converted.length > 200 ? converted.slice(0, 200) : converted;
}

/**
 * Locate `~/.claude/projects/<project>` for one workspace, or explain the miss.
 *
 * **P6.1051 — the two halves landed TOGETHER, which is the only way they can.**
 * `pinnedName` is `CLAUDE_CODE_PROJECT_DIR_NAME`, already validated and already
 * gated on the root having come from `CLAUDE_CONFIG_DIR`
 * ({@link resolveClaudeProjectDirNameOverride}); when it is set it REPLACES the
 * derivation outright, with no fall-back to the derived name. That refusal is the
 * page's own: *"If you start Claude Code with the same `CLAUDE_CONFIG_DIR` but
 * without `CLAUDE_CODE_PROJECT_DIR_NAME`, it reads and writes the derived
 * directory again. The sessions stored under your name stay on disk"* — so BOTH
 * directories can exist under one config dir, and falling back would import the
 * memories of the launches that did not set the name. A miss stays a miss, and
 * {@link collectMemories}'s warning says where it looked.
 *
 * Until that pairing landed the override was deliberately not honoured, for the
 * reason recorded here and now discharged: this importer's root was `~/.claude`
 * unless a caller passed one and it did not read `CLAUDE_CONFIG_DIR` at all, so
 * honouring the name alone would have pointed at a directory the runtime never
 * wrote to.
 */
function findClaudeProjectDir(
  claudeDir: string,
  workspaceRootPath: string,
  pinnedName?: string,
): string | undefined {
  const projects = join(claudeDir, 'projects');
  if (!existsSync(projects)) return undefined;
  if (pinnedName) {
    const pinned = join(projects, pinnedName);
    return existsSync(pinned) ? pinned : undefined;
  }
  const name = claudeProjectDirName(workspaceRootPath);
  const exact = join(projects, name);
  if (existsSync(exact)) return exact;
  // The over-200 arm: the prefix is deterministic, the hash suffix is not.
  let matches: string[];
  try {
    matches = readdirSync(projects, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith(name))
      .map(entry => join(projects, entry.name));
  } catch {
    return undefined;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Project memories (P6.521, Q-den 54 = option 2: import MEMORIES, not chats).
 *
 * ## Where they come from, and where they land
 *
 * `memory.md` § Storage location: *"Each project gets its own memory directory
 * at `~/.claude/projects/<project>/memory/`"*, holding *"a `MEMORY.md` index and
 * one topic file per memory"*. They land FLAT in the workspace root: the index
 * at `<ws>/MEMORY.md`, which is exactly what `getProjectMemoryFilePath` reads,
 * and each topic file beside it — where the index's own relative links already
 * point, so nothing has to be rewritten.
 *
 * ## Why flat is the honest landing, not a shortcut
 *
 * `memory-layers.ts` records that *"this fork has no auto-memory DIRECTORY"* —
 * locally a topic file is one the index `@path`-imports, and an `@path` in a
 * MEMORY.md is deliberately NOT loaded at startup. The page says the same of
 * Claude's own: *"Claude Code doesn't load topic files such as `user_role.md` or
 * `feedback_testing.md` at startup. Claude reads them on demand using its
 * standard file tools when it needs the information."* So a topic file copied
 * beside the index behaves here exactly as it did there — present, addressable,
 * not preloaded. A subdirectory would have broken the index's links to buy
 * nothing.
 *
 * The workspace root is already where `AGENTS.md`, imported subagent definitions
 * and our own `MEMORY.md` live, so this adds no new mixing; a topic file whose
 * name is already taken is a per-file `conflict` and is never overwritten.
 *
 * ## Chats are NOT imported, deliberately
 *
 * The transcripts sit in the same `<project>` directory as `*.jsonl`. Option 3
 * (import both, chats read-only) was refused because it needs a chat-store
 * schema this product owns on none of the three runtimes. When transcripts are
 * present the user is TOLD they were left behind, with the reason, so a
 * deliberate omission is not read as a defect.
 */
function collectMemories(
  claudeDir: string,
  workspaceRootPath: string,
  warnings: string[],
  pinnedProjectDirName?: string,
): MarkdownFileItem[] {
  const projectDir = findClaudeProjectDir(claudeDir, workspaceRootPath, pinnedProjectDirName);
  if (!projectDir) return [];

  let transcripts = 0;
  try {
    transcripts = readdirSync(projectDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).length;
  } catch {
    transcripts = 0;
  }
  if (transcripts > 0) {
    warnings.push(
      `${transcripts} Claude Code chat transcript(s) in ${projectDir} were NOT imported, deliberately: `
      + 'a conversation would have to be rewritten into this product’s own session store, and no such '
      + 'conversion exists on any runtime. Your memories and setup move; the chat history stays in Claude Code.',
    );
  }

  const memoryDir = join(projectDir, 'memory');
  if (!existsSync(memoryDir)) return [];
  // Every `.md` in the directory, index first so the preview reads top-down.
  const files = markdownFilesIn(memoryDir, () => false);
  return files.sort((a, b) => {
    if (a.fileName === MEMORY_INDEX_FILE_NAME) return -1;
    if (b.fileName === MEMORY_INDEX_FILE_NAME) return 1;
    return a.fileName.localeCompare(b.fileName);
  });
}

/** The index our own project-memory reader loads; every other file is a topic file. */
const MEMORY_INDEX_FILE_NAME = 'MEMORY.md';

/** Where an imported memory file lands (`<ws>/<name>.md`, index included). */
function memoryTargetPath(ws: string, fileName: string): string {
  return join(ws, fileName);
}

// ---------------------------------------------------------------------------
// The import receipt, and the drift a re-run can name (P6.522)
// ---------------------------------------------------------------------------

/**
 * What a re-run of the importer can answer, and the ONE conflict policy behind
 * every answer (P6.522, Q-den 55 = option 2: one-shot PLUS a re-run that diffs).
 *
 * ## The gap this closes
 *
 * Re-running the dry run has always re-badged everything create / merge /
 * conflict, so "is anything different?" was already answerable. What it could
 * NOT answer is the question a switching user actually has — *which side
 * moved?* A destination whose bytes differ from the source reads `conflict`
 * whether Claude Code changed upstream, the user edited the copy here, or both.
 * Three situations, one badge, and the two setups drift with nothing saying so.
 *
 * The fix is a receipt: at apply time we record the SOURCE bytes we copied.
 * A later run compares three values instead of two — recorded, source now,
 * destination now — and the four cases separate cleanly.
 *
 * ## The conflict policy, STATED rather than implied
 *
 * **The copy in this workspace always wins. This import never overwrites a file
 * it did not just create.** That is not new behaviour — `copyMarkdownFile` and
 * `writeSkill` have both refused to overwrite from the start — it is the same
 * rule finally written where the user can read it, in the preview line for the
 * change it applies to. When only Claude Code moved, the update is not taken
 * silently and is not taken at all; the preview says so and names the one action
 * that takes it (delete the local copy, import again). A rule the user can act
 * on beats a merge they cannot predict.
 *
 * ## What the receipt does NOT cover, stated rather than left to be discovered
 *
 * Only kinds whose source is a single file are recorded: the instruction file
 * and the three markdown copy kinds. A skill is a directory, and permissions,
 * hooks and MCP servers are MERGES into a target that holds other writers' work
 * — for those, "which side moved" is not a question one hash can answer, and a
 * half-true drift line would be worse than none.
 *
 * ## No watcher, deliberately
 *
 * Option 3 (a standing sync) was refused because it makes an external directory
 * a live input to our permission posture. Nothing here polls, watches or reads
 * `~/.claude` outside an explicit scan the user asked for.
 */
const IMPORT_RECEIPT_VERSION = 1;

function importReceiptPath(ws: string): string {
  return join(ws, NESSY_AGENT_PROJECT_DIR, 'claude-import.json');
}

/** The confirmation identity minus the action: kind, then name. */
function receiptKey(kind: ClaudeImportKind, name: string): string {
  return `${kind} ${name}`;
}

function fileHash(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

function loadImportReceipt(ws: string): Record<string, string> {
  const raw = readJsonObject(importReceiptPath(ws));
  if (!raw || raw.version !== IMPORT_RECEIPT_VERSION) return {};
  const sources = raw.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sources as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function saveImportReceipt(ws: string, sources: Record<string, string>): void {
  const path = importReceiptPath(ws);
  mkdirSync(dirname(path), { recursive: true });
  const body = { version: IMPORT_RECEIPT_VERSION, importedAt: Date.now(), sources };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
}

/**
 * Which side moved since the import, in one sentence, or `undefined` when the
 * question does not arise (never imported, or nothing moved).
 *
 * `destHash === undefined` means the destination is not a single file we can
 * compare — the instruction kind writes a BLOCK inside `AGENTS.md`, so only the
 * upstream half is knowable there. Saying half honestly beats saying nothing.
 */
function driftNote(
  recorded: string | undefined,
  sourceHash: string | undefined,
  destHash: string | undefined,
): string | undefined {
  if (!recorded || !sourceHash) return undefined;
  const upstreamMoved = sourceHash !== recorded;
  if (destHash === undefined) {
    return upstreamMoved ? 'Changed in Claude Code since you imported it' : undefined;
  }
  const localMoved = destHash !== recorded;
  if (!upstreamMoved && !localMoved) return undefined;
  if (upstreamMoved && !localMoved) {
    return 'Changed in Claude Code since you imported it — your copy here is kept; '
      + 'delete it and import again to take the newer one';
  }
  if (!upstreamMoved && localMoved) return 'You changed this copy here since importing it — it is kept';
  return 'Changed on BOTH sides since you imported it — your copy here is kept';
}

/** Append a drift sentence to a change's own detail, keeping both. */
function withDrift(detail: string | undefined, note: string | undefined): string | undefined {
  if (!note) return detail;
  return detail ? `${detail} · ${note}` : note;
}

/**
 * The interactive-mode keys a Claude `settings.json` can carry, with what this
 * product does about each one (P6.520, Q-den 53 = option 2).
 *
 * ## Why a list rather than an `if`
 *
 * Before this list the six keys landed in NO family: the importer read
 * `permissions` and `hooks` out of `settings.json` and every other key fell off
 * the end without a line saying so. A user who pasted their file got a preview
 * that was silently short.
 *
 * Option 1 — accept all six as compat aliases, the way `safe-mode.ts` accepts
 * `CLAUDE_CODE_SAFE_MODE` beside `NESSY_SAFE_MODE` — was refused by the owner
 * for the reason the alias precedent itself makes clear: an alias is honest only
 * when the NAME it aliases onto has behaviour. Accepting a name with nothing
 * behind it manufactures the silent divergence this fork keeps closing. So each
 * key is either implemented or NAMED as unimplemented, never quietly accepted.
 *
 * ## The absences are measured, not assumed
 *
 * Each `null` below was checked against this tree with `spellcheck`'s own four
 * hits as the positive control on the same rig (2026-09-06):
 * `editorMode`/vim → 0 hits, emoji shortcodes → 0 hits, prompt suggestions →
 * the Claude SDK's `prompt_suggestion` event, which `backend/claude/event-adapter.ts`
 * DROPS with "no composer chip surface", and the only `autoContinue` in the tree
 * is the AskUser tool's countdown, unrelated to a claude.ai usage limit.
 *
 * ## One correction to the row's own plan
 *
 * The row says option 1 becomes reachable "once `keybindingFlavor` and
 * `vimInsertModeRemaps` have host implementations to alias onto".
 * `keybindingFlavor` never will: `settings-reference.md` marks it
 * *"Deprecated since v2.1.261 and has no effect"* upstream, adding that "Claude
 * Code still accepts `keybindingFlavor`, so a settings file that sets it stays
 * valid". Aliasing onto a key that does nothing in the runtime that owns it
 * would be the inert acceptance option 1 was refused for, so its diagnostic says
 * "deprecated upstream" rather than "we have no equivalent" — a different fact
 * with a different future.
 */
const CLAUDE_INTERACTIVE_SETTING_KEYS: ReadonlyArray<{
  key: string;
  /** `null` when nothing here implements it; the sentence explains WHY it is null. */
  nessySurface: string | null;
  why: string;
}> = Object.freeze([
  {
    key: 'spellcheck',
    nessySurface: 'Settings → Input → Spell Check',
    why: 'the only one of the six with a built surface',
  },
  {
    key: 'autoContinueAtUsageLimit',
    nessySurface: null,
    why: 'Nessy does not wait out a claude.ai usage limit inside an open session, so there is no setting to carry this onto.',
  },
  {
    key: 'emojiCompletionEnabled',
    nessySurface: null,
    why: 'the composer has no `:shortcode:` emoji completion to turn off.',
  },
  {
    key: 'keybindingFlavor',
    nessySurface: null,
    why: 'this key is deprecated upstream since Claude Code v2.1.261 and has no effect there either, so there is nothing to carry.',
  },
  {
    key: 'promptSuggestionEnabled',
    nessySurface: null,
    why: 'Nessy shows no grayed-out prompt suggestions — the runtime’s own suggestion event is dropped for want of a composer surface.',
  },
  {
    key: 'vimInsertModeRemaps',
    nessySurface: null,
    why: 'the composer has no vim editor mode, so an INSERT-mode remap has nothing to bind in.',
  },
]);

/**
 * The `spellcheck` sub-keys this product cannot carry.
 *
 * `settings-reference.md` § `spellcheck` types the value as an *"object with
 * `enabled` (Boolean), `checker` … `language` … and `color`"*, where the checker
 * is one of aspell/hunspell/ispell installed on `PATH`. Nessy's spell check is
 * the composer textarea's own (Chromium's), which picks its dictionary from the
 * OS and draws its own underline — so `enabled` transfers and the other three
 * have no destination. Naming them is the difference between an import that
 * carried less than the user wrote and one that SAID it carried less.
 */
const CLAUDE_SPELLCHECK_UNCARRIED_SUBKEYS = Object.freeze(['checker', 'language', 'color']);

const SPELLCHECK_TARGET = 'Settings → Input → Spell Check';

/**
 * Read the interactive-mode keys and decide each one's fate.
 *
 * Only keys the file actually SETS are reported: a settings file that mentions
 * none of the six earns no warnings, because a diagnostic about a key nobody
 * wrote is noise, and noise is what makes a warnings list stop being read.
 */
function collectInteractiveSettings(claudeDir: string, warnings: string[]): SettingItem[] {
  const settings = readJsonObject(join(claudeDir, 'settings.json'));
  if (!settings) return [];
  const items: SettingItem[] = [];

  for (const entry of CLAUDE_INTERACTIVE_SETTING_KEYS) {
    if (!(entry.key in settings)) continue;
    if (entry.nessySurface === null) {
      warnings.push(`settings.json "${entry.key}" was not imported: ${entry.why}`);
      continue;
    }
    if (entry.key === 'spellcheck') {
      const item = resolveSpellcheck(settings.spellcheck, warnings);
      if (item) items.push(item);
    }
  }
  return items;
}

/**
 * `spellcheck` → the stored `spellCheck` preference, three-way like every other
 * kind here, and for the same reason: this import never overwrites a choice the
 * user already made.
 *
 * - never set here  → `create`, and the apply writes it.
 * - set to the same → `merge`, nothing to write; a second import is a no-op.
 * - set to the other → `conflict`, left untouched and named, exactly as an
 *   occupied skill directory is.
 *
 * The DEFAULT is deliberately not treated as a choice: `getSpellCheck()` folds
 * the unset case into `false`, so reading it would make the ordinary import
 * (`enabled: true` onto a fresh install) a permanent conflict and the accepted
 * key inert — the failure this row exists to prevent. The stored value is read
 * raw instead.
 */
function resolveSpellcheck(raw: unknown, warnings: string[]): SettingItem | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push(
      'settings.json "spellcheck" was not imported: it must be an object with an `enabled` boolean, '
      + `as documented, but it is ${Array.isArray(raw) ? 'an array' : typeof raw}.`,
    );
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const enabled = value.enabled;
  if (typeof enabled !== 'boolean') {
    warnings.push('settings.json "spellcheck" was not imported: its `enabled` field is missing or not a boolean.');
    return undefined;
  }
  const uncarried = CLAUDE_SPELLCHECK_UNCARRIED_SUBKEYS.filter(sub => sub in value);
  if (uncarried.length > 0) {
    warnings.push(
      `settings.json "spellcheck": ${uncarried.map(sub => `\`${sub}\``).join(', ')} `
      + 'could not be imported — Nessy spell-checks the input with the built-in checker, which takes its '
      + 'dictionary and its underline from the system. Only `enabled` was carried.',
    );
  }

  let stored: boolean | undefined;
  try {
    stored = loadStoredConfig()?.spellCheck;
  } catch {
    stored = undefined;
  }
  const action: ClaudeImportAction = stored === undefined
    ? 'create'
    : stored === enabled ? 'merge' : 'conflict';
  const detail = action === 'conflict'
    ? `Spell check is already ${stored ? 'on' : 'off'} here; left unchanged`
    : `Turn spell check ${enabled ? 'on' : 'off'}`;
  return { claudeKey: 'spellcheck', target: SPELLCHECK_TARGET, enabled, action, detail };
}

function collect(options: ClaudeSetupImportOptions): CollectedImport {
  const { claudeDir, claudeJsonPath, fromConfigDirEnv } = resolveDirs(options);
  const codexDir = resolveCodexDir(options);
  const warnings: string[] = [];
  // P6.523 — the collision rule, applied once and in one direction: the Claude
  // setup is read first and wins every name, and the codex side is appended and
  // named where it loses. See `CODEX_INSTRUCTION_FILES`' docblock for why.
  const instruction = collectInstruction(claudeDir, warnings);
  const mcp = collectMcp(claudeDir, claudeJsonPath, warnings);
  const codexInstruction = collectCodexInstruction(codexDir, warnings);
  if (instruction && codexInstruction) {
    warnings.push(
      `${join(codexDir, codexInstruction.fileName)} was NOT imported: your Claude Code CLAUDE.md supplies the `
      + 'imported instruction block, and one block cannot carry two files. Merge them by hand if you need both.',
    );
  }
  return {
    instruction: instruction ?? (codexInstruction ? { content: codexInstruction.content } : undefined),
    instructionSourceName: instruction ? 'CLAUDE.md' : codexInstruction?.fileName,
    instructionSourcePath: instruction
      ? join(claudeDir, 'CLAUDE.md')
      : codexInstruction ? join(codexDir, codexInstruction.fileName) : undefined,
    permission: collectPermissions(claudeDir, warnings),
    hook: collectHooks(claudeDir, warnings),
    skills: collectSkills(claudeDir),
    mcp: [...mcp, ...collectCodexMcp(codexDir, new Set(mcp.map(item => item.name)), warnings)],
    agents: collectAgents(claudeDir, warnings),
    commands: collectCommands(claudeDir),
    memories: collectMemories(
      claudeDir,
      options.workspaceRootPath,
      warnings,
      resolveClaudeProjectDirNameOverride(fromConfigDirEnv),
    ),
    settings: collectInteractiveSettings(claudeDir, warnings),
    warnings,
  };
}

/**
 * `create` when nothing is there, `merge` when the destination already holds
 * exactly this file, `conflict` when it holds something else.
 *
 * An unreadable destination is a `conflict` rather than a `create`: something IS
 * there and we could not tell what, and the badge that never writes is the safe
 * reading of that.
 */
function copyAction(sourcePath: string, destination: string): ClaudeImportAction {
  if (!existsSync(destination)) return 'create';
  try {
    return readFileSync(sourcePath, 'utf-8') === readFileSync(destination, 'utf-8') ? 'merge' : 'conflict';
  } catch {
    return 'conflict';
  }
}

/** Where an imported agent definition lands (`<ws>/<name>.md`). */
function agentTargetPath(ws: string, fileName: string): string {
  return join(ws, fileName);
}

/** Where an imported slash command lands (`<ws>/.nessy-agent/commands/<name>.md`). */
function commandTargetPath(ws: string, fileName: string): string {
  return join(ws, NESSY_AGENT_PROJECT_DIR, 'commands', fileName);
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

/**
 * Read `~/.claude` and produce the full set of changes an import would make,
 * WITHOUT writing anything. This is the preview the UI shows before the user
 * confirms.
 */
export async function computeClaudeSetupImportPlan(
  options: ClaudeSetupImportOptions,
): Promise<ClaudeSetupImportPlan> {
  const { claudeDir } = resolveDirs(options);
  const collected = collect(options);
  const ws = options.workspaceRootPath;
  const changes: ClaudeImportChange[] = [];
  // P6.522 — what a PREVIOUS apply recorded, so this run can say which side
  // moved. Empty on a first import, which is why every drift note is optional.
  const receipt = loadImportReceipt(ws);

  if (collected.instruction) {
    const agentsPath = join(ws, 'AGENTS.md');
    // P3.242 — REFUSE, NAMING THE OVERRIDE (owner ruling 2026-09-01).
    //
    // `AGENTS.override.md` in this directory SUPERSEDES `AGENTS.md` entirely —
    // codex's own per-directory rule, mirrored by `agentsMdSupersededIn` and
    // honoured by every walk that reads project instructions. So with an
    // override present the import used to report success, write the block into
    // `AGENTS.md`, and have it reach NO model: the silencing is host-wide, not
    // codex-only, because `projectInstructionFilesIn` takes no runtime.
    //
    // Three other options were measured (write into the effective file; import
    // and warn; write both) and the owner chose this one, for a reason worth
    // keeping: a named refusal behaves IDENTICALLY on all three runtimes, where
    // writing into the override would quietly redefine a file whose name means
    // *local override* and whose deletion would take the guidance with it. We
    // decline requested work, and the user learns the truth at the moment they
    // ask instead of being told success and getting silence.
    //
    // `conflict` is the existing vocabulary for "refused, reported, nothing
    // written": `run()` routes it to `result.skipped` and the panel already
    // paints it amber. Nothing new is invented here.
    const superseded = agentsMdSupersededIn(ws);
    changes.push({
      kind: 'instruction',
      action: superseded ? 'conflict' : (existsSync(agentsPath) ? 'merge' : 'create'),
      // P6.523 — whichever file actually supplied the block. `CLAUDE.md` when a
      // Claude setup is present, the codex `AGENTS.md`/`AGENTS.override.md`
      // otherwise, so the preview names what it read.
      name: collected.instructionSourceName ?? 'CLAUDE.md',
      target: 'AGENTS.md',
      detail: superseded
        ? `${AGENTS_OVERRIDE_INSTRUCTION_FILE} supersedes AGENTS.md in this workspace, so an import there `
          + `would never be read; remove ${AGENTS_OVERRIDE_INSTRUCTION_FILE} or move its contents into `
          + 'AGENTS.md, then import again'
        // The destination is a BLOCK inside AGENTS.md, so only the upstream half
        // of the drift is knowable here — `driftNote` is told that explicitly.
        : withDrift(
          `${countLines(collected.instruction.content)} lines`,
          driftNote(
            receipt[receiptKey('instruction', collected.instructionSourceName ?? 'CLAUDE.md')],
            collected.instructionSourcePath ? fileHash(collected.instructionSourcePath) : undefined,
            undefined,
          ),
        ),
    });
  }

  if (collected.permission) {
    changes.push({
      kind: 'permission',
      action: 'merge',
      name: 'Permission rules',
      target: 'permissions.json',
      detail: `${collected.permission.rules.length} rule(s)`,
    });
  }

  if (collected.hook) {
    changes.push({
      kind: 'hook',
      action: existsSync(join(ws, 'hooks.json')) ? 'merge' : 'create',
      name: 'Hooks',
      target: 'hooks.json',
      detail: collected.hook.events.join(', '),
    });
  }

  for (const skill of collected.skills) {
    const exists = existsSync(join(getWorkspaceSkillsPath(ws), skill.slug));
    changes.push({
      kind: 'skill',
      action: exists ? 'conflict' : 'create',
      name: skill.slug,
      target: join('skills', skill.slug),
    });
  }

  for (const server of collected.mcp) {
    const exists = sourceExists(ws, server.slug);
    changes.push({
      kind: 'mcp',
      action: exists ? 'conflict' : 'create',
      name: server.name,
      target: join('sources', server.slug),
      // P6.522 — an item that still needs authorisation says so ON THE CHANGE,
      // so the fact survives into `result.applied` and the done list, instead of
      // living only in a warnings block the preview screen owns.
      //
      // P6.654 closed that row's residue on the renderer side: `needsAuth` is the
      // machine-readable half the done screen reads to draw its review card, and
      // `detail` stays the prose the preview list shows. The two must agree, so
      // they are set from the SAME predicate on the line below.
      ...(server.needsReview ? { needsAuth: true as const } : {}),
      detail: server.needsReview
        ? `${server.config.transport} · imported disabled: it declares environment variables or headers `
          + 'that were not carried; add them in Sources, then enable it'
        : server.config.transport,
    });
  }

  // P6.442 — the two copy kinds. THREE-WAY, which the skill kind is not, and the
  // reason is the row's own control: "a second dry run after applying reports
  // merge, not create". A skill is a directory and its badge is create-or-
  // conflict; a single file can be compared, so an already-imported file is
  // `merge` (idempotent, nothing to write) while a destination whose bytes
  // DIFFER stays `conflict` — the user edited it, or a different definition
  // holds that name. Neither badge ever overwrites.
  for (const agent of collected.agents) {
    const destination = agentTargetPath(ws, agent.fileName);
    changes.push({
      kind: 'agent',
      action: copyAction(agent.sourcePath, destination),
      name: agent.fileName,
      target: agent.fileName,
      detail: withDrift(destination, driftNote(
        receipt[receiptKey('agent', agent.fileName)], fileHash(agent.sourcePath), fileHash(destination),
      )),
    });
  }

  for (const command of collected.commands) {
    const destination = commandTargetPath(ws, command.fileName);
    changes.push({
      kind: 'command',
      action: copyAction(command.sourcePath, destination),
      name: command.fileName,
      target: join(NESSY_AGENT_PROJECT_DIR, 'commands', command.fileName),
      detail: withDrift(destination, driftNote(
        receipt[receiptKey('command', command.fileName)], fileHash(command.sourcePath), fileHash(destination),
      )),
    });
  }

  // P6.521 — PER FILE, three-way like the two copy kinds beside it. `detail`
  // separates the index from a topic file, because only the index is loaded at
  // session start and the user is deciding what moves.
  for (const memory of collected.memories) {
    const destination = memoryTargetPath(ws, memory.fileName);
    changes.push({
      kind: 'memory',
      action: copyAction(memory.sourcePath, destination),
      name: memory.fileName,
      target: memory.fileName,
      detail: withDrift(
        memory.fileName === MEMORY_INDEX_FILE_NAME
          ? 'Memory index — loaded at the start of every session'
          : 'Topic file — read on demand, not loaded at startup',
        driftNote(receipt[receiptKey('memory', memory.fileName)], fileHash(memory.sourcePath), fileHash(destination)),
      ),
    });
  }

  // P6.520 — last, because it is the one family that lands outside `ws`. The
  // action was decided at collection time against the stored value; the plan
  // only describes it.
  for (const setting of collected.settings) {
    changes.push({
      kind: 'setting',
      action: setting.action,
      name: setting.claudeKey,
      target: setting.target,
      detail: setting.detail,
    });
  }

  return {
    claudeDir,
    workspaceRootPath: ws,
    changes,
    warnings: collected.warnings,
    empty: changes.length === 0,
  };
}

function countLines(text: string): number {
  return text.split('\n').length;
}

// ---------------------------------------------------------------------------
// Apply (confirmed write)
// ---------------------------------------------------------------------------

/**
 * Perform the writes for an import. Recomputes the conversion from the same
 * collector the preview used, then writes each non-conflict change. Conflicts
 * are reported as skipped and never overwrite an existing skill/source.
 */
export async function applyClaudeSetupImportPlan(
  options: ClaudeSetupImportOptions,
  /**
   * The plan the user actually confirmed. Apply must re-read `~/.claude` to get
   * the PAYLOADS (a plan carries descriptors, and it crosses the RPC boundary as
   * JSON, so bodies and rule sets cannot ride along), and `~/.claude` can change
   * between the preview and the confirm. Supplying the confirmed plan pins the
   * write to it: a change that is no longer what was confirmed is refused and
   * named instead of written. Omitted, apply confirms its own fresh scan — the
   * old behaviour, kept for a non-interactive caller.
   */
  confirmedPlan?: ClaudeSetupImportPlan,
): Promise<ClaudeSetupImportResult> {
  const fresh = await computeClaudeSetupImportPlan(options);
  const collected = collect(options);
  const ws = options.workspaceRootPath;
  const applied: ClaudeImportChange[] = [];
  const skipped: ClaudeImportChange[] = [];
  const errors: string[] = [];

  // The identity a confirmation is about: kind + name + the action the user saw.
  // `detail` is deliberately excluded — a line count shifting is not a different
  // change — but a `create` that has become a `conflict` IS.
  const identity = (change: ClaudeImportChange) => `${change.kind}\u0000${change.name}\u0000${change.action}`;
  let plan = fresh;
  if (confirmedPlan) {
    const confirmed = new Set(confirmedPlan.changes.map(identity));
    const freshIds = new Set(fresh.changes.map(identity));
    for (const change of confirmedPlan.changes) {
      if (!freshIds.has(identity(change))) {
        errors.push(
          `${change.kind} "${change.name}": ~/.claude changed after the preview, so this was not imported. `
          + 'Scan again to see the current set.',
        );
      }
    }
    plan = { ...fresh, changes: fresh.changes.filter(change => confirmed.has(identity(change))) };
  }

  const run = (change: ClaudeImportChange, write: () => void): void => {
    if (change.action === 'conflict') {
      skipped.push(change);
      return;
    }
    try {
      write();
      applied.push(change);
    } catch (error) {
      errors.push(`${change.kind} "${change.name}": ${errText(error)}`);
    }
  };

  for (const change of plan.changes) {
    switch (change.kind) {
      case 'instruction':
        run(change, () => writeInstruction(ws, collected.instruction!.content));
        break;
      case 'permission':
        run(change, () => writePermissions(ws, collected.permission!));
        break;
      case 'hook':
        run(change, () => writeHooks(ws, collected.hook!));
        break;
      case 'skill': {
        const skill = collected.skills.find(s => s.slug === change.name);
        if (skill) run(change, () => writeSkill(ws, skill));
        break;
      }
      case 'mcp': {
        const server = collected.mcp.find(s => s.name === change.name);
        if (server) run(change, () => writeMcp(ws, server));
        break;
      }
      case 'agent': {
        const agent = collected.agents.find(a => a.fileName === change.name);
        if (agent) run(change, () => copyMarkdownFile(agent, agentTargetPath(ws, agent.fileName)));
        break;
      }
      case 'command': {
        const command = collected.commands.find(c => c.fileName === change.name);
        if (command) run(change, () => copyMarkdownFile(command, commandTargetPath(ws, command.fileName)));
        break;
      }
      case 'memory': {
        const memory = collected.memories.find(m => m.fileName === change.name);
        if (memory) run(change, () => copyMarkdownFile(memory, memoryTargetPath(ws, memory.fileName)));
        break;
      }
      case 'setting': {
        const setting = collected.settings.find(item => item.claudeKey === change.name);
        if (setting) run(change, () => writeSetting(setting));
        break;
      }
    }
  }

  // P6.522 — record the SOURCE bytes of everything actually written, so the NEXT
  // run can tell an upstream change from a local edit. Only single-file kinds are
  // recorded; the reason is on `IMPORT_RECEIPT_VERSION`'s docblock. Merged into
  // the existing receipt, never replacing it: a partial import must not erase
  // what an earlier one recorded about the kinds it did not touch.
  const receiptSources = loadImportReceipt(ws);
  let receiptChanged = false;
  const record = (kind: ClaudeImportKind, name: string, sourcePath: string): void => {
    const hash = fileHash(sourcePath);
    if (!hash || receiptSources[receiptKey(kind, name)] === hash) return;
    receiptSources[receiptKey(kind, name)] = hash;
    receiptChanged = true;
  };
  for (const change of applied) {
    if (change.kind === 'instruction') {
      if (collected.instructionSourcePath) record('instruction', change.name, collected.instructionSourcePath);
    }
    else if (change.kind === 'agent') {
      const item = collected.agents.find(a => a.fileName === change.name);
      if (item) record('agent', change.name, item.sourcePath);
    } else if (change.kind === 'command') {
      const item = collected.commands.find(c => c.fileName === change.name);
      if (item) record('command', change.name, item.sourcePath);
    } else if (change.kind === 'memory') {
      const item = collected.memories.find(m => m.fileName === change.name);
      if (item) record('memory', change.name, item.sourcePath);
    }
  }
  if (receiptChanged) {
    try {
      saveImportReceipt(ws, receiptSources);
    } catch (error) {
      // A receipt that cannot be written costs the NEXT run its drift lines and
      // nothing else, so it is reported and never fails the import.
      errors.push(`import receipt: ${errText(error)} — the next scan cannot report what changed since now.`);
    }
  }

  return { applied, skipped, errors };
}

/**
 * The one write that leaves the workspace (P6.520).
 *
 * `setSpellCheck` is the same installation-global writer Settings → Input calls,
 * reused rather than reimplemented, so the imported value lands on exactly the
 * surface the toggle reads and the composer renders. A `false` return is the
 * store refusing the mutation, and it is raised so the change is reported as an
 * error instead of silently counted as applied.
 *
 * A `merge` is a no-op BY CONSTRUCTION — the stored value already equals the
 * imported one — so it returns without touching the store and is reported
 * applied, the same shape an already-imported markdown file has.
 */
function writeSetting(item: SettingItem): void {
  if (item.claudeKey !== 'spellcheck' || item.action === 'merge') return;
  if (!setSpellCheck(item.enabled)) {
    throw new Error('the stored configuration could not be written');
  }
}

function writeInstruction(ws: string, content: string): void {
  mkdirSync(ws, { recursive: true });
  const path = join(ws, 'AGENTS.md');
  const block = `${AGENTS_IMPORT_BEGIN}\n${content.trim()}\n${AGENTS_IMPORT_END}`;
  let next: string;
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf-8');
    const begin = existing.indexOf(AGENTS_IMPORT_BEGIN);
    const end = existing.indexOf(AGENTS_IMPORT_END);
    if (begin !== -1 && end !== -1 && end > begin) {
      // Replace the managed region in place — idempotent re-import.
      next = existing.slice(0, begin) + block + existing.slice(end + AGENTS_IMPORT_END.length);
    } else {
      next = `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
    }
  } else {
    next = `${block}\n`;
  }
  writeFileSync(path, next, 'utf-8');
}

function writePermissions(ws: string, item: PermissionItem): void {
  const existing = loadRawWorkspacePermissions(ws) ?? {};
  const dsl = existing.permissionDsl && typeof existing.permissionDsl === 'object'
    ? (existing.permissionDsl as { version?: unknown; rules?: unknown })
    : {};
  const rules: unknown[] = Array.isArray(dsl.rules) ? [...dsl.rules] : [];
  const presentIds = new Set(
    rules
      .filter((r): r is { id: string } => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
      .map(r => r.id),
  );
  for (const rule of item.rules) {
    if (presentIds.has(rule.id)) continue; // idempotent by id
    rules.push(rule);
  }
  saveWorkspacePermissions(ws, {
    ...existing,
    permissionDsl: {
      version: typeof dsl.version === 'number' ? dsl.version : NESSY_PERMISSION_DSL_VERSION,
      rules,
    },
  });
}

function writeHooks(ws: string, item: HookItem): void {
  mkdirSync(ws, { recursive: true });
  const path = join(ws, 'hooks.json');
  const existing = readJsonObject(path);
  const existingHooks = existing?.hooks && typeof existing.hooks === 'object' && !Array.isArray(existing.hooks)
    ? (existing.hooks as Record<string, unknown>)
    : {};
  const merged: Record<string, AutomationMatcher[]> = {};
  for (const [event, matchers] of Object.entries(existingHooks)) {
    if (Array.isArray(matchers)) merged[event] = [...(matchers as AutomationMatcher[])];
  }
  for (const [event, matchers] of Object.entries(item.automations)) {
    const present = new Set((merged[event] ?? []).map(m => JSON.stringify(m)));
    const additions = (matchers as AutomationMatcher[]).filter(m => !present.has(JSON.stringify(m)));
    merged[event as AgentEvent] = [...(merged[event] ?? []), ...additions];
  }
  writeFileSync(path, `${JSON.stringify({ ...existing, hooks: merged }, null, 2)}\n`, 'utf-8');
}

function writeSkill(ws: string, skill: SkillItem): void {
  const dest = join(getWorkspaceSkillsPath(ws), skill.slug);
  if (existsSync(dest)) return; // conflict guard (already handled in plan)
  mkdirSync(getWorkspaceSkillsPath(ws), { recursive: true });
  cpSync(skill.sourceDir, dest, { recursive: true });
}

/**
 * P6.442 — the copy both new kinds share. A `cpSync` of one file, guarded
 * against overwriting for the same reason `writeSkill` is: the plan already
 * marked an occupied destination `conflict`, and this is the second gate for
 * the window between the preview and the write.
 */
function copyMarkdownFile(item: MarkdownFileItem, destination: string): void {
  if (existsSync(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(item.sourcePath, destination);
}

function writeMcp(ws: string, server: McpItem): void {
  if (sourceExists(ws, server.slug)) return; // conflict guard
  mkdirSync(getWorkspaceSourcesPath(ws), { recursive: true });
  const config: FolderSourceConfig = {
    id: `${server.slug}_claude-import`,
    name: server.name,
    slug: server.slug,
    // Disabled when config we could not carry (`env`/`headers`) was declared.
    enabled: !server.needsReview,
    provider: 'claude-import',
    type: 'mcp',
    mcp: server.config,
    createdAt: Date.now(),
  };
  saveSourceConfig(ws, config);
}

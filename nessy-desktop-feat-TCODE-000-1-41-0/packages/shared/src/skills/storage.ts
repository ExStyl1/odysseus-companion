/**
 * Skills Storage
 *
 * CRUD operations for workspace skills.
 * Skills are stored in {workspace}/skills/{slug}/ directories.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import type { LoadedSkill, SkillMetadata, SkillSource } from './types.ts';
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import { parseSkillToolList, skillEffortLevel, skillFrontmatterBoolean } from '../capabilities/runtime-skill-content.ts';
import {
  validateIconValue,
  findIconFile,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
} from '../utils/icon.ts';

// ============================================================
// Agent Skills Paths (Issue #171)
// ============================================================

/** Global agent skills directory: ~/.agents/skills/ */
export const GLOBAL_AGENT_SKILLS_DIR = join(homedir(), '.agents', 'skills');

/** Project-level agent skills relative directory name */
export const PROJECT_AGENT_SKILLS_DIR = '.agents/skills';

/**
 * Environment override for the administrator-owned skills roots (P6.8).
 *
 * Set it to a single directory to read that one INSTEAD of the defaults below;
 * set it to the empty string to turn the tier off entirely. It exists because
 * the defaults are locations this fork does not own, and an operator who
 * disagrees with that choice needs a way to say so that is not a code change.
 */
export const ADMIN_SKILLS_DIR_ENV = 'NESSY_ADMIN_SKILLS_DIR';

/**
 * Administrator-owned skills roots — machine-wide directories the signed-in
 * user cannot write, provisioned by whoever manages the host.
 *
 * ## Why there are TWO of them, and why they are not ours
 *
 * P6.8 opened because codex reports a fourth skill scope, `admin`, that we had
 * no origin for. Measuring it turned up the same tier in a second runtime, on a
 * different path, with the OPPOSITE precedence — which is the divergence this
 * function exists to flatten, not a detail:
 *
 * **codex — source strength, `openai/codex` `rust-v0.148.0`.**
 * `ext/skills/src/host_roots.rs:114` is the only construction site of
 * `SkillScope::Admin`, and it is the SYSTEM config layer's `skills/` folder.
 * That layer's file is a hardcoded absolute path — `/etc/codex/config.toml` on
 * Unix (`config/src/loader/mod.rs:61`), `%ProgramData%\OpenAI\Codex\config.toml`
 * on Windows — with the folder taken as `file.parent()`
 * (`config/src/state.rs:223`). codex's own `ext/skills/src/host_roots_tests.rs:282`
 * asserts the pair `(SkillScope::Admin, system_folder.join("skills"))`.
 *
 * **Claude — documentation is the contract, plus the vendored binary.**
 * `skills.md#where-skills-live` lists an `Enterprise` tier for "All users in
 * your organization", and `skills.md#remove-a-skill` gives the shape verbatim:
 * "an administrator deletes the skill's directory from `.claude/skills/` inside
 * the managed settings directory, for example
 * `/etc/claude-code/.claude/skills/<skill-name>/` on Linux". The managed
 * directory per OS is `managed-settings.md#delivery-mechanisms`. The vendored
 * SDK binary agrees — it logs `managed=`, `user=`, `project=` from one loader.
 *
 * **Both are absolute and machine-wide, so both runtimes read them whatever
 * home we hand them** — including the ephemeral per-session `CODEX_HOME` this
 * app builds. On an administrator-managed host a codex or Claude session
 * therefore already gains skills a Pi session does not, and nothing in the
 * product said so. Reading the SAME directories here is what makes the three
 * agree. Inventing a Nessy-owned path instead would create a tier no
 * administrator has ever populated: it would close the vocabulary gap while
 * leaving the actual divergence exactly where it was.
 *
 * ## The posture this takes, stated rather than assumed
 *
 * This is a machine-wide read that is ON by default. It is narrower than the
 * project tier, which IS trust-gated (W6): a repository is attacker-supplied by
 * anyone who can get you to clone it, whereas these directories are writable
 * only by whoever administers the host — the same party who installs the app.
 * Neither codex nor Claude gates them either. `ADMIN_SKILLS_DIR_ENV` is the
 * operator's off switch.
 *
 * Returns `[]` when the tier is disabled, so callers skip it explicitly instead
 * of reading a sentinel path. Paths are returned whether or not they exist;
 * `loadSkillsFromDir` already treats a missing directory as empty.
 */
export function getAdminAgentSkillsDirs(): string[] {
  const override = process.env[ADMIN_SKILLS_DIR_ENV];
  if (override !== undefined) {
    const trimmed = override.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (process.platform === 'win32') {
    // codex: `%ProgramData%` with codex's own literal fallback
    // (`loader/mod.rs` `DEFAULT_PROGRAM_DATA_DIR_WINDOWS`).
    // Claude: `C:\Program Files\ClaudeCode` — and the docs say the legacy
    // `%ProgramData%\ClaudeCode` path is deliberately NOT read, so do not
    // "helpfully" add it here.
    const programData = process.env.ProgramData ?? 'C:\\ProgramData';
    return [
      join(programData, 'OpenAI', 'Codex', 'skills'),
      join('C:\\Program Files', 'ClaudeCode', '.claude', 'skills'),
    ];
  }

  const claudeManagedDir = process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode'
    : '/etc/claude-code';

  return [
    '/etc/codex/skills',
    join(claudeManagedDir, '.claude', 'skills'),
  ];
}

export interface LoadAllSkillsOptions {
  pluginSkills?: LoadedSkill[];
  /**
   * Whether the project `projectRoot` (working directory) is explicitly trusted
   * (W6). Project `.agents/skills` are read only when true; defaults to
   * untrusted (fail-closed). Global and workspace skills always load.
   */
  projectTrusted?: boolean;
  /**
   * The administrator-owned skill roots this load should read, OVERRIDING
   * `getAdminAgentSkillsDirs`. `[]` means "no administrator tier".
   *
   * ## Why this seam exists, and why it is OPTIONAL where the inventory's is not
   *
   * P2.461's half of the same hazard. The inventory builder's `adminSkillsDirs`
   * is REQUIRED (`capabilities/native-sources.ts`) because its callers are a
   * handful of rigs plus one production site, so a compiler error at each is
   * cheap and exhaustive. This loader is called from production paths all over
   * the tree, and requiring the field there would make every caller restate a
   * default it has no opinion about — the noise a required parameter buys
   * nothing for.
   *
   * So a rig's pin here stays what it was, the environment variable
   * `NESSY_ADMIN_SKILLS_DIR` — and until now that was the ONLY pin available,
   * which is a rig setting a process-global to isolate one call. This field is
   * the per-call alternative: it does not weaken the environment lever (that
   * lever is still what an OPERATOR has, and it is still read here by default),
   * it just means a test no longer has to reach for a process-wide switch to
   * make one load machine-independent.
   *
   * `capabilities/__tests__/admin-skills-dirs-pinned.test.ts` accepts either pin
   * at a `loadAllSkills` call site.
   */
  adminSkillsDirs?: readonly string[];
}

/**
 * Normalize requiredSources frontmatter to a clean string array.
 * Accepts a single string or array of strings, trims whitespace, and deduplicates.
 */
function normalizeRequiredSources(value: unknown): string[] | undefined {
  const asArray = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : undefined;

  if (!asArray) return undefined;

  const normalized = Array.from(new Set(
    asArray
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean)
  ));

  return normalized.length > 0 ? normalized : undefined;
}

// ============================================================
// Parsing
// ============================================================

/**
 * Upper bound on a description derived from the body. Matches the 1,536-character
 * point at which Claude truncates `description` + `when_to_use` in the skill
 * listing, so a derived value can never be longer than what a listing shows.
 */
const MAX_DERIVED_DESCRIPTION_CHARS = 1_536;

/** Read the first spelling present, so hyphenated and camelCase both work. */
function frontmatterField(data: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = data[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Trimmed non-empty string, or undefined. */
function optionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * `skills.md:248` — "Boolean fields accept `yes`, `no`, `on`, `off`, `1`, and
 * `0` in any letter case, in addition to `true` and `false`."
 *
 * Not cosmetic leniency: `disable-model-invocation` and `user-invocable` have an
 * absent value meaning the permissive default, so an unrecognised spelling reads
 * as "not stated" and lets the model invoke a skill whose author wrote
 * `disable-model-invocation: yes` to stop exactly that. Getting the spelling set
 * wrong is a control bypass, not a parsing nicety.
 *
 * The table itself now lives beside the other frontmatter readers
 * (`skillFrontmatterBoolean`) because `context: fork`'s `background` needs the
 * same one; this alias keeps the local call sites unchanged.
 */
const optionalBoolean = skillFrontmatterBoolean;

/**
 * Tool list for the DISPLAY path, delegating to the one tokenizer the
 * enforcement path uses (`parseSkillToolList`).
 *
 * They used to be two separate readers of one field, and they disagreed on a
 * comma inside a parameterized rule and on whitespace as a delimiter — harmless
 * while `allowed-tools` was unenforced, a live divergence once R17b made it a
 * grant. The only difference kept here is the empty case: a present-but-empty
 * field is an empty GRANT to the enforcement path and simply "nothing to show"
 * to this one.
 */
function normalizeToolList(value: unknown): string[] | undefined {
  const entries = parseSkillToolList(value);
  return entries && entries.length > 0 ? entries : undefined;
}

/**
 * `arguments` — "Accepts a space-separated string or a YAML list. Names map to
 * argument positions in order" (`skills.md:256`).
 *
 * Deliberately NOT `normalizeToolList`, which de-duplicates: here the ORDER is
 * the position mapping, so dropping or reordering a single entry would re-point
 * every name after it at a different argument. Nothing is filtered — a name that
 * cannot be written as `$name` simply never matches.
 *
 * Space-separated, unlike `paths`, which the same table spells comma-separated.
 */
function normalizeArgumentNames(value: unknown): string[] | undefined {
  const entries = Array.isArray(value)
    ? value.map(entry => (typeof entry === 'string' ? entry : String(entry ?? '')))
    : typeof value === 'string'
      ? value.match(/[^\s,]+/g) ?? []
      : undefined;
  if (!entries) return undefined;
  const normalized = entries.map(entry => entry.trim());
  return normalized.some(Boolean) ? normalized : undefined;
}

/**
 * First markdown paragraph of a skill body, used when `description` is absent.
 * Skips ATX headings and fenced-code openers so the fallback is prose.
 */
function descriptionFromBody(body: string): string | undefined {
  const paragraph: string[] = [];
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('---') || line.startsWith('===')) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }
  const joined = paragraph.join(' ').trim();
  if (!joined) return undefined;
  return joined.length > MAX_DERIVED_DESCRIPTION_CHARS
    ? joined.slice(0, MAX_DERIVED_DESCRIPTION_CHARS)
    : joined;
}

/**
 * `paths` — "Glob patterns that limit when this skill is activated. Accepts a
 * comma-separated string or a YAML list." (`skills.md:267`).
 *
 * COMMA-separated, unlike `arguments` (`:256`), which is space-separated: a glob
 * may legitimately contain a space (`docs/my notes/**`), so whitespace is not a
 * delimiter here. Patterns are kept verbatim and in order — `expandRulePatterns`
 * is what expands braces, under its own budget.
 */
function normalizePathPatterns(value: unknown): string[] | undefined {
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? value.split(',')
      : undefined;
  if (!entries) return undefined;
  const normalized = Array.from(new Set(entries.map(entry => entry.trim()).filter(Boolean)));
  return normalized.length > 0 ? normalized : undefined;
}

/** The invocation-control subset of a skill's frontmatter. */
export interface SkillInvocationControls {
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  paths?: string[];
}

/**
 * Read the documented invocation controls out of already-parsed frontmatter.
 *
 * Exported because `capabilities/native-sources.ts` parses SKILL.md a SECOND
 * time to pin an inventory record, and the two readers MUST agree on the field
 * names and their accepted spellings. Anything that parses skill frontmatter
 * and needs these fields must call this instead of re-deriving them.
 */
export function readSkillInvocationControls(data: Record<string, unknown>): SkillInvocationControls {
  const disableModelInvocation = optionalBoolean(
    frontmatterField(data, 'disable-model-invocation', 'disableModelInvocation'),
  );
  const userInvocable = optionalBoolean(frontmatterField(data, 'user-invocable', 'userInvocable'));
  const allowedTools = normalizeToolList(frontmatterField(data, 'allowed-tools', 'allowedTools'));
  const disallowedTools = normalizeToolList(frontmatterField(data, 'disallowed-tools', 'disallowedTools'));
  // `globs` is this repo's own pre-contract spelling of the same idea — "file
  // patterns that trigger this skill" — and was parsed but never read by
  // anything. It is unified here as the legacy alias of the documented `paths`
  // rather than left as a second, silently inert field.
  const paths = normalizePathPatterns(frontmatterField(data, 'paths', 'globs'));
  return {
    ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }),
    ...(userInvocable === undefined ? {} : { userInvocable }),
    ...(allowedTools ? { allowedTools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(paths ? { paths } : {}),
  };
}

/**
 * Parse SKILL.md content and extract frontmatter + body.
 *
 * Lenient by contract, not by accident. Per the published Agent Skills
 * frontmatter reference, `name` defaults to the directory name and `description`
 * falls back to the first body paragraph, and malformed YAML loads the body with
 * empty metadata rather than dropping the skill. The one hard requirement is a
 * name: without it there is nothing to invoke the skill by, so that case (and
 * only that case) still returns `null`.
 *
 * `diagnostics` carries a stable code for each fallback taken, for a caller that
 * can surface it. This function deliberately does not log.
 */
function parseSkillFile(
  content: string,
  options: { directoryName?: string } = {},
): { metadata: SkillMetadata; body: string; diagnostics: string[] } | null {
  const diagnostics: string[] = [];

  let data: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = matter(content);
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // Malformed YAML: keep the body, treat the metadata as empty.
    diagnostics.push('skill-frontmatter-unparsed');
    body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  }

  const declaredName = optionalString(frontmatterField(data, 'name'));
  const derivedName = optionalString(options.directoryName);
  const name = declaredName ?? derivedName;
  if (!name) return null;
  if (!declaredName) diagnostics.push('skill-name-derived-from-directory');

  const declaredDescription = optionalString(frontmatterField(data, 'description'));
  const derivedDescription = declaredDescription ?? descriptionFromBody(body);
  if (!declaredDescription && derivedDescription) diagnostics.push('skill-description-derived-from-body');

  // Validate and extract optional icon field
  // Only accepts emoji or URL - rejects inline SVG and relative paths
  const icon = validateIconValue(data.icon, 'Skills');

  const whenToUse = optionalString(frontmatterField(data, 'when_to_use', 'whenToUse'));
  const model = optionalString(frontmatterField(data, 'model'));
  const effort = skillEffortLevel(optionalString(frontmatterField(data, 'effort')));
  const argumentNames = normalizeArgumentNames(frontmatterField(data, 'arguments', 'argumentNames'));
  const argumentHint = optionalString(frontmatterField(data, 'argument-hint', 'argumentHint'));

  return {
    metadata: {
      name,
      // A description is a hint, not an identity: an empty one is acceptable.
      description: derivedDescription ?? '',
      ...(whenToUse ? { whenToUse } : {}),
      ...(argumentNames ? { argumentNames } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      ...readSkillInvocationControls(data),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      globs: data.globs as string[] | undefined,
      alwaysAllow: data.alwaysAllow as string[] | undefined,
      icon,
      requiredSources: normalizeRequiredSources(data.requiredSources),
    },
    body,
    diagnostics,
  };
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single skill from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param slug - Skill directory name
 * @param source - Where this skill is loaded from
 */
function loadSkillFromDir(skillsDir: string, slug: string, source: SkillSource): LoadedSkill | null {
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  // Check directory exists
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    return null;
  }

  // Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return null;
  }

  // Read and parse SKILL.md
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch {
    return null;
  }

  const parsed = parseSkillFile(content, { directoryName: slug });
  if (!parsed) {
    return null;
  }

  return {
    slug,
    metadata: parsed.metadata,
    content: parsed.body,
    iconPath: findIconFile(skillDir),
    path: skillDir,
    source,
    ...(parsed.diagnostics.length > 0 ? { diagnostics: Object.freeze(parsed.diagnostics) } : {}),
  };
}

/**
 * True if a readdir entry is a directory, following symlinks whose target is
 * a directory. `entry.isDirectory()` is false for symlink entries even when
 * they point at a directory, so a symlinked skill dir would otherwise be
 * dropped (mirrors loadSkillFromDir's statSync-based check). Broken/dangling
 * symlinks throw from statSync and are treated as not-a-directory.
 */
function isSkillDirEntry(parentDir: string, entry: import('fs').Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(parentDir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Load all skills from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param source - Where these skills are loaded from
 */
function loadSkillsFromDir(skillsDir: string, source: SkillSource): LoadedSkill[] {
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: LoadedSkill[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!isSkillDirEntry(skillsDir, entry)) continue;

      const skill = loadSkillFromDir(skillsDir, entry.name, source);
      if (skill) {
        skills.push(skill);
      }
    }
  } catch {
    // Ignore errors reading skills directory
  }

  return skills;
}

/**
 * Load a single skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function loadSkill(workspaceRoot: string, slug: string): LoadedSkill | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  return loadSkillFromDir(skillsDir, slug, 'workspace');
}

/**
 * Load all skills from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function loadWorkspaceSkills(workspaceRoot: string): LoadedSkill[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  return loadSkillsFromDir(skillsDir, 'workspace');
}

// ── Skills cache ────────────────────────────────────────────────────────
// loadAllSkills reads from up to 4 directories on every call (~100ms).
// The result rarely changes during a session, so we cache it per
// (adminSkillsDir, workspaceRoot, projectRoot) pair with a 5-minute safety TTL.
// The admin directory is in the key because it is resolved from the
// environment (ADMIN_SKILLS_DIR_ENV) and a test — or an operator flipping the
// override — must not be served a result computed against the old root.

const skillsCache = new Map<string, { skills: LoadedSkill[]; ts: number }>();
const SKILLS_CACHE_TTL = 5 * 60_000; // 5 minutes

/** Invalidate the skills cache (call on working dir change or skill file events). */
export function invalidateSkillsCache(): void {
  skillsCache.clear();
}

/**
 * Load all skills from all sources (global, workspace, project, admin)
 * Skills with the same slug are overridden by higher-priority sources.
 * Priority: global (lowest) < workspace < project < admin (highest)
 *
 * **Why admin sits at the TOP.** The two runtimes that already have this tier
 * disagree, so the ordering had to be chosen rather than copied — and only one
 * of them actually states a rule about same-NAME skills. Claude does, verbatim
 * (`skills.md#where-skills-live`): "Across levels, enterprise overrides
 * personal, and personal overrides project." codex does NOT: its `scope_rank`
 * (`ext/skills/src/loader/host_merge.rs`, re-read at `rust-v0.150.1` where that
 * file is byte-identical) is a DISPLAY
 * sort, and the merge above it dedupes by PATH only — its own test keeps a
 * `duplicate-skill` at both `Repo` and `User` scope rather than resolving it. So
 * the only precedence in evidence is Claude's, and this follows it. (codex's
 * config-layer precedence puts the system layer BELOW user, but that governs
 * config keys, not skill names, and reading it as a skill rule would be
 * inventing one.)
 *
 * Results are cached per (adminSkillsDirs, workspaceRoot, projectRoot) tuple.
 * Call invalidateSkillsCache() on working directory changes or skill file
 * events.
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param projectRoot - Optional project root (working directory) for project-level skills
 */
export function loadAllSkills(workspaceRoot: string, projectRoot?: string, options: LoadAllSkillsOptions = {}): LoadedSkill[] {
  const projectTrusted = options.projectTrusted === true;
  const adminSkillsDirs = options.adminSkillsDirs ?? getAdminAgentSkillsDirs();
  // The cache key joins the admin roots on NUL, because a directory path may
  // contain any character EXCEPT NUL — so no two distinct root lists collide
  // into one key. It must stay written as the ESCAPE and never as the raw byte:
  // a source file carrying a literal NUL is treated as binary by plain `grep`,
  // which then reports nothing for symbols that ARE present — the exact trap
  // that makes an absence claim untrustworthy. `bun scripts/check-nul-bytes.ts`
  // enforces it; the escape is byte-identical at runtime.
  const cacheKey = `${adminSkillsDirs.join('\u0000')}::${workspaceRoot}::${projectRoot ?? ''}::${projectTrusted ? 't' : 'u'}`;
  const now = Date.now();
  const cached = skillsCache.get(cacheKey);
  if (cached && now - cached.ts < SKILLS_CACHE_TTL) {
    return mergePluginSkills(cached.skills, options.pluginSkills);
  }

  const skillsBySlug = new Map<string, LoadedSkill>();

  // 1. Global skills (lowest priority): ~/.agents/skills/
  for (const skill of loadSkillsFromDir(GLOBAL_AGENT_SKILLS_DIR, 'global')) {
    skillsBySlug.set(skill.slug, skill);
  }

  // 2. Workspace skills (medium priority)
  for (const skill of loadWorkspaceSkills(workspaceRoot)) {
    skillsBySlug.set(skill.slug, skill);
  }

  // 3. Project skills: {projectRoot}/.agents/skills/
  //    Repository-owned: read only when the project is explicitly trusted (W6).
  if (projectRoot && projectTrusted) {
    const projectSkillsDir = join(projectRoot, PROJECT_AGENT_SKILLS_DIR);
    for (const skill of loadSkillsFromDir(projectSkillsDir, 'project')) {
      skillsBySlug.set(skill.slug, skill);
    }
  }

  // 4. Administrator-owned skills (highest priority): see getAdminAgentSkillsDirs().
  //    NOT trust-gated — these directories are outside any repository and are
  //    writable only by whoever administers the host.
  for (const adminSkillsDir of adminSkillsDirs) {
    for (const skill of loadSkillsFromDir(adminSkillsDir, 'admin')) {
      skillsBySlug.set(skill.slug, skill);
    }
  }

  const result = Array.from(skillsBySlug.values());
  skillsCache.set(cacheKey, { skills: result, ts: now });
  return mergePluginSkills(result, options.pluginSkills);
}

function mergePluginSkills(nativeSkills: LoadedSkill[], pluginSkills: LoadedSkill[] = []): LoadedSkill[] {
  if (pluginSkills.length === 0) return nativeSkills;
  const skillsBySlug = new Map(nativeSkills.map(skill => [skill.slug, skill]));
  const pluginBySlug = new Map<string, LoadedSkill>();
  for (const skill of pluginSkills) {
    if (skill.source !== 'plugin') continue;
    pluginBySlug.set(skill.slug, skill);
  }
  for (const [slug, skill] of pluginBySlug) {
    if (!skillsBySlug.has(slug)) {
      skillsBySlug.set(slug, skill);
    }
  }
  return Array.from(skillsBySlug.values());
}

/**
 * Load a single skill by slug from all sources (admin > project > workspace > global).
 * Unlike loadAllSkills(), this only reads the specific slug directory — O(1) not O(N).
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill slug to load
 * @param projectRoot - Optional project root for project-level skills
 */
export function loadSkillBySlug(workspaceRoot: string, slug: string, projectRoot?: string): LoadedSkill | null {
  // Highest priority: administrator-owned. Must be probed FIRST here for the
  // same reason it is written LAST in loadAllSkills — the two functions resolve
  // one order, and only the direction of the loop differs.
  for (const adminSkillsDir of getAdminAgentSkillsDirs()) {
    const skill = loadSkillFromDir(adminSkillsDir, slug, 'admin');
    if (skill) return skill;
  }

  // Next: project-level
  if (projectRoot) {
    const projectSkillsDir = join(projectRoot, PROJECT_AGENT_SKILLS_DIR);
    const skill = loadSkillFromDir(projectSkillsDir, slug, 'project');
    if (skill) return skill;
  }

  // Medium priority: workspace
  const workspaceSkill = loadSkillFromDir(getWorkspaceSkillsPath(workspaceRoot), slug, 'workspace');
  if (workspaceSkill) return workspaceSkill;

  // Lowest priority: global
  return loadSkillFromDir(GLOBAL_AGENT_SKILLS_DIR, slug, 'global');
}

/**
 * Get icon path for a skill
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function getSkillIconPath(workspaceRoot: string, slug: string): string | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);

  if (!existsSync(skillDir)) {
    return null;
  }

  return findIconFile(skillDir) || null;
}

// ============================================================
// Delete Operations
// ============================================================

/**
 * Delete a skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function deleteSkill(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);

  if (!existsSync(skillDir)) {
    return false;
  }

  try {
    rmSync(skillDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Check if a skill exists in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function skillExists(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  return existsSync(skillDir) && existsSync(skillFile);
}

/**
 * List skill slugs in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function listSkillSlugs(workspaceRoot: string): string[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);

  if (!existsSync(skillsDir)) {
    return [];
  }

  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => {
        if (!isSkillDirEntry(skillsDir, entry)) return false;
        const skillFile = join(skillsDir, entry.name, 'SKILL.md');
        return existsSync(skillFile);
      })
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ============================================================
// Icon Download (uses shared utilities)
// ============================================================

/**
 * Download an icon from a URL and save it to the skill directory.
 * Returns the path to the downloaded icon, or null on failure.
 */
export async function downloadSkillIcon(
  skillDir: string,
  iconUrl: string
): Promise<string | null> {
  return downloadIcon(skillDir, iconUrl, 'Skills');
}

/**
 * Check if a skill needs its icon downloaded.
 * Returns true if metadata has a URL icon and no local icon file exists.
 */
export function skillNeedsIconDownload(skill: LoadedSkill): boolean {
  return needsIconDownload(skill.metadata.icon, skill.iconPath);
}

// Re-export icon utilities for convenience
export { isIconUrl } from '../utils/icon.ts';

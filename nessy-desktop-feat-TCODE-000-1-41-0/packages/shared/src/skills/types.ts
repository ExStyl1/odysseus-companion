/**
 * Skills Types
 *
 * Type definitions for workspace skills.
 * Skills are specialized instructions that extend Claude's capabilities.
 */

/**
 * Skill metadata from SKILL.md YAML frontmatter.
 *
 * Field names and their hyphenation follow the published Agent Skills contract
 * (`https://code.claude.com/docs/en/skills.md` → "Frontmatter reference"):
 * `name` is optional and defaults to the directory name, `description` is only
 * *recommended* and falls back to the first body paragraph, and the invocation
 * controls are hyphenated (`allowed-tools`, `disallowed-tools`,
 * `disable-model-invocation`, `user-invocable`) except `when_to_use`, which the
 * docs spell with an underscore. The parser accepts the documented spelling and
 * the camelCase spelling of each, and stores the camelCase form here.
 */
export interface SkillMetadata {
  /** Display name for the skill. Derived from the directory when not declared. */
  name: string;
  /** Brief description shown in skill list */
  description: string;
  /**
   * `when_to_use` — extra trigger context (phrases, example requests) appended
   * to `description` in the skill listing.
   */
  whenToUse?: string;
  /**
   * `arguments` — "Named positional arguments for `$name` substitution in the
   * skill content. Accepts a space-separated string or a YAML list. Names map to
   * argument positions in order." (`skills.md:256`). Stored in declaration order,
   * because the order IS the position mapping.
   */
  argumentNames?: string[];
  /**
   * `argument-hint` — "Hint shown during autocomplete to indicate expected
   * arguments. Example: `[issue-number]` or `[filename] [format]`."
   * (`skills.md:255`). Display-only: it never affects substitution.
   */
  argumentHint?: string;
  /**
   * `allowed-tools` — tools pre-approved for the turn that invokes the skill.
   * ENFORCED since R17b: the pinned invocation record carries it and the gate
   * skips the permission prompt for the calls it names, so a wrong value here
   * is a wrong grant, not a wrong label. It does NOT restrict — an unlisted
   * tool stays callable (see `collectSkillToolGrants`); `disallowedTools` is
   * the field that removes. Tokenized by `parseSkillToolList`, the single
   * reader of the field.
   */
  allowedTools?: string[];
  /** `disallowed-tools` — tools removed from the pool while the skill is active. */
  disallowedTools?: string[];
  /**
   * `disable-model-invocation` — `true` blocks the MODEL from invoking the
   * skill and keeps it out of the listing. The user can still invoke it.
   * Absent means the documented default, `false`.
   */
  disableModelInvocation?: boolean;
  /**
   * `user-invocable` — `false` hides the skill from the `/` menu (the model can
   * still invoke it). Absent means the documented default, `true`; a stored
   * `false` must stay distinguishable from "not stated".
   */
  userInvocable?: boolean;
  /** `model` — model override while the skill is active. Captured only. */
  model?: string;
  /**
   * `effort` — "Effort level when this skill is active. Overrides the session
   * effort level. Default: inherits from session. Options: `low`, `medium`,
   * `high`, `xhigh`, `max`; available levels depend on the model."
   * (`skills.md:262`). An unrecognized level is dropped rather than stored, so
   * the session simply keeps its own effort.
   */
  effort?: string;
  /**
   * `paths` — "Glob patterns that limit when this skill is activated. Accepts a
   * comma-separated string or a YAML list. When set, Claude loads the skill
   * automatically only when working with files matching the patterns. Uses the
   * same format as path-specific rules." (`skills.md:267`).
   *
   * AUTOMATIC activation only. A user invoking the skill by name is never gated
   * by it — getting that backwards would hide a skill from its own invocation.
   */
  paths?: string[];
  /**
   * Legacy spelling of {@link paths}, retained because it is what this repo
   * accepted before the documented field existed (and what the skill editor's
   * frontmatter hint still names). Both spellings populate `paths`; this field
   * carries the raw declaration only.
   */
  globs?: string[];
  /** Optional tools to always allow when skill is active */
  alwaysAllow?: string[];
  /**
   * Optional icon - emoji or URL only.
   * - Emoji: rendered directly in UI (e.g., "🔧")
   * - URL: auto-downloaded to icon.{ext} file
   * Note: Relative paths and inline SVG are NOT supported.
   */
  icon?: string;
  /** Optional source slugs to auto-enable when this skill is invoked */
  requiredSources?: string[];
}

/**
 * Source of a loaded skill.
 *
 * `'admin'` is an ADMINISTRATOR-OWNED tier: a machine-wide directory that the
 * signed-in user cannot write, provisioned by whoever manages the host. It was
 * added for P6.8, and the reason it is an ORIGIN rather than a flag is that
 * codex already reports one and we had nothing to put it in.
 *
 * **Measured at `openai/codex` `rust-v0.148.0`, source strength.**
 * `codex-rs/protocol/src/protocol.rs` declares
 * `pub enum SkillScope { User, Repo, System, Admin }` with no doc comment on
 * any variant, and `codex-rs/ext/skills/src/host_roots.rs:114` is the only
 * place `SkillScope::Admin` is constructed:
 *
 *     ConfigLayerSource::System { .. } => {
 *         roots.push(local_root(
 *             config_folder.join(SKILLS_DIR_NAME),
 *             SkillScope::Admin,
 *         ));
 *     }
 *
 * so codex's `admin` scope is the SYSTEM config layer's `skills/` folder —
 * `/etc/codex/skills` on Unix, `%ProgramData%\OpenAI\Codex\skills` on
 * Windows (`codex-rs/config/src/loader/mod.rs:61` and its `windows` sibling,
 * with `config_folder()` = `file.parent()` at `config/src/state.rs:223`).
 *
 * **The trap, and it is the whole reason this comment is long: codex's two
 * privileged-sounding scope names are INVERTED relative to the obvious
 * reading.** `SkillScope::System` is NOT the machine-wide one — it is
 * `$CODEX_HOME/skills/.system`, the cache of skills codex preinstalls into the
 * user's own home from `github.com/openai/skills`. The machine-wide,
 * administrator-owned one is `Admin`. Anything that maps codex `system` onto
 * an administrator origin is exactly backwards; both halves were measured on
 * the shipped `rust-v0.148.0` binary (the `.system` half by probe, the `admin`
 * half from codex's own `host_roots_tests.rs:282`).
 */
export type SkillSource = 'admin' | 'global' | 'workspace' | 'project' | 'plugin';

export interface PluginSkillOrigin {
  kind: 'plugin';
  pluginInstanceId: string;
  pluginId: string;
  marketplaceId: string;
  version: string;
  capabilityId: string;
  scope: 'user/global' | 'workspace' | 'project';
}

/**
 * Plugin name for project-level and global skills.
 *
 * The SDK derives plugin names from `path.basename()` of the registered plugin
 * directory. Both `{project}/.agents/` and `~/.agents/` share the basename
 * `.agents`, so skills from either tier resolve to `.agents:skillSlug`.
 */
export const AGENTS_PLUGIN_NAME = '.agents';

/**
 * A loaded skill with parsed content
 */
export interface LoadedSkill {
  /** Directory name (slug) */
  slug: string;
  /** Parsed metadata from YAML frontmatter */
  metadata: SkillMetadata;
  /** Full SKILL.md content (without frontmatter) */
  content: string;
  /** Absolute path to icon file if exists */
  iconPath?: string;
  /** Absolute path to skill directory */
  path: string;
  /** Where this skill was loaded from */
  source: SkillSource;
  /**
   * Stable codes for everything the parser had to fall back on (a derived name,
   * a derived description, unparsable YAML). Present so a lenient load is
   * visible rather than silent; the loader is the only producer.
   *
   * There is no diagnostic channel below this level — `loadSkillFromDir` has no
   * logger and must not invent one. The surface that should render these is the
   * capability-diagnostics pipeline (`capabilities/resolver.ts` →
   * `toSafeDiagnostic` → the renderer's Sources/Skills detail page); wiring
   * them there is a UI change with its own review, so for now they ride the
   * loaded skill for any caller that wants them.
   */
  diagnostics?: readonly string[];
  /** True for projected plugin skills that must not be edited in native storage. */
  readOnly?: boolean;
  /** Capability origin for plugin-provided skills. */
  origin?: PluginSkillOrigin;
}

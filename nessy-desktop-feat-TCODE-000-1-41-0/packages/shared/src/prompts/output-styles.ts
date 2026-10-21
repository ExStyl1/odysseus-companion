import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { CONFIG_DIR } from '../config/paths.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts';
import { managedFileTrustVerdict, managedSystemDirForPlatform } from '../config/managed-system-paths.ts';

export const DEFAULT_OUTPUT_STYLE_ID = 'default';
const CUSTOM_OUTPUT_STYLE_PREFIX = 'custom:';
/**
 * `output-styles.md:83` — "Plugins can also ship output styles in an
 * `output-styles/` directory". A plugin style's id carries its `pluginKey` so two
 * plugins shipping the same style name stay distinguishable, and so a selection
 * survives a plugin update (the key is version-less; the instance id is not).
 */
const PLUGIN_OUTPUT_STYLE_PREFIX = 'plugin:';
const OUTPUT_STYLES_DIR = join(NESSY_AGENT_PROJECT_DIR, 'output-styles');
/** `output-styles.md:51` — the user level, the one an app-global selection is always resolvable from. */
const USER_OUTPUT_STYLES_DIR = join(CONFIG_DIR, 'output-styles');
/**
 * P6.239 (denominator B21) — the MANAGED level, which this file read at no point.
 *
 * `output-styles.md` § *Create a custom output style* names three levels and we
 * had two of them, verbatim: *"User: `~/.claude/output-styles`; Project:
 * `.claude/output-styles`; Managed policy: `.claude/output-styles` inside the
 * managed settings directory"*. An administrator could therefore ship no output
 * style at all — the whole tier was absent, not merely mis-ranked.
 *
 * ## The path, and the ONE place this deviates from the page
 *
 * The page puts a `.claude/` segment inside the managed settings directory. This
 * fork drops it, everywhere, for every managed and personal tier: the managed
 * INSTRUCTION file is `<systemDir>/CLAUDE.md` (`managed-system-paths.ts`'s
 * `MANAGED_INSTRUCTION_FILE`), and the user level above is
 * `<CONFIG_DIR>/output-styles` rather than `<CONFIG_DIR>/.claude/output-styles`
 * — because in this fork the config directory IS the `.claude` equivalent. So
 * the managed root is `<systemDir>/output-styles`, consistent with its own
 * sibling rather than with a segment that means nothing here. Stated rather than
 * silently chosen, per AGENTS.md's rule for where the documentation runs out.
 *
 * ## Why it is read LAST
 *
 * {@link outputStyleDirectories} is ordered lowest precedence first and
 * {@link discoverCustomOutputStyles} lets a later directory overwrite an
 * earlier one's name. `features-overview.md` § *Understand how features layer*
 * puts the managed tier above every authored level, so managed is pushed after
 * the project chain and a same-named managed style wins.
 *
 * ## Why the trust verdict, and why PER FILE
 *
 * The same reason the managed instruction file carries one: this is
 * un-excludable prose entering the system prompt from a machine-wide root, so a
 * root any local user can write is not the administrator's voice. A
 * `'unverifiable-platform'` verdict WITHHOLDS the file rather than trusting it —
 * the direction P3.331 established for the instruction file.
 *
 * It is applied to each candidate FILE, not to the directory:
 * `managedFileTrustVerdict` demands `isFile()`, so handing it a directory
 * returns `'untrusted'` and would disable the whole tier on every machine while
 * looking like a security check that passes.
 */
const MANAGED_OUTPUT_STYLES_DIRNAME = 'output-styles';
const MAX_OUTPUT_STYLE_BYTES = 32 * 1024;
/**
 * Bound on the project ancestor chain {@link outputStyleDirectories} walks
 * (`output-styles.md:55`). Deep enough for any real monorepo nesting, small
 * enough that one prompt build cannot stat an unbounded directory chain. When
 * the cap truncates, the retained directories are the ones NEAREST the working
 * directory — the ones the closest-wins rule favors anyway.
 */
const MAX_OUTPUT_STYLE_WALK_DEPTH = 32;

export type OutputStyleKind = 'builtin' | 'custom' | 'plugin';

export interface OutputStyleOption {
  id: string;
  kind: OutputStyleKind;
  label: string;
  description?: string;
  path?: string;
  /**
   * Display-only provenance for a plugin-shipped style, so the picker can say
   * which plugin a style came from. Never an authority input.
   */
  pluginName?: string;
}

/**
 * One plugin-shipped style, already read through the pinned capability
 * materializer by the caller.
 *
 * The CONTENT is passed in rather than a path: a plugin bundle is immutable and
 * integrity-verified, and reading it belongs behind the snapshot lease that
 * proved the bundle hash. This module never opens a plugin file itself.
 */
export interface PluginOutputStyleSource {
  /** `plugin:<pluginKey>:<slug>` — build it with {@link pluginOutputStyleId}. */
  id: string;
  /** Raw `.md` bytes as UTF-8: frontmatter plus body, exactly as authored. */
  content: string;
  /** The style name from the manifest capability, used when the file names none. */
  fallbackLabel?: string;
  /** Owning plugin's display name, for the picker only. */
  pluginName?: string;
}

interface OutputStyleDefinition extends OutputStyleOption {
  prompt: string;
  /**
   * `output-styles.md:93` — `keep-coding-instructions` keeps "Claude Code's
   * built-in software engineering instructions". Built-in styles always keep
   * them (`:17` — the Default style "is the existing system prompt"); a custom
   * style defaults to `false` per the same table row.
   */
  keepCodingInstructions: boolean;
}

interface OutputStyleRoots {
  workspaceRootPath?: string;
  workingDirectory?: string;
  /**
   * The canonical, validated active project root — same field name and meaning
   * as `capabilities/resolver.ts` and `agents/definitions.ts`.
   *
   * `output-styles.md:55` — project styles "load from every `.claude/output-styles/`
   * between the working directory and the repository root". This is the walk's
   * STOP boundary: `outputStyleDirectories` climbs from `workingDirectory` up to
   * here. Absent means "walk nothing beyond the working directory" — the
   * pre-walk single-directory behaviour — so existing call sites that omit it
   * are unchanged.
   */
  projectRoot?: string;
  /**
   * Plugin-shipped styles for this capability generation. Supplied by the
   * caller that holds the snapshot lease; absent means no plugin contributes a
   * style, which is every unmanaged/plugin-less session.
   */
  pluginStyles?: readonly PluginOutputStyleSource[];
  /**
   * Whether the user has trusted the project at `workingDirectory`.
   * `output-styles.md:52` puts a project level next to the user level; ours is
   * `<project>/.nessy-agent/output-styles` and it is read only behind the same
   * trust gate `loadAgentDefinitions` applies to project agent definitions.
   */
  projectTrusted?: boolean;
  /**
   * P6.239 — the managed settings directory. Test seam only; production omits
   * it and gets {@link managedSystemDirForPlatform}, so there is one answer to
   * "where is the managed tier" and `native-sources.ts` gets it from the same
   * function.
   */
  managedSystemDir?: string;
}

const BUILTIN_OUTPUT_STYLE_DEFINITIONS: readonly OutputStyleDefinition[] = [
  {
    id: DEFAULT_OUTPUT_STYLE_ID,
    kind: 'builtin',
    label: 'Default',
    description: 'Use Nessy Desktop standard responses.',
    prompt: '',
    keepCodingInstructions: true,
  },
  {
    // `output-styles.md#built-in-output-styles` — the documented Concise
    // built-in is FOUR sentences, and ours carried only the first:
    // "**Concise**: Claude leads with the result, skips preamble and narration,
    // and keeps responses short by default, while doing the engineering work as
    // thoroughly as in the Default style. When you ask for an explanation or
    // more detail, Claude answers in full. Claude always keeps the complete
    // content of error reports, security warnings, and confirmations for
    // destructive actions."
    //
    // The first three lines below predate the page and are kept as written; the
    // three appended ones are the qualifiers the page attaches and ours dropped:
    // thoroughness is unchanged, detail is available on request, and — the one
    // with a safety dimension — error reports, security warnings and
    // destructive-action confirmations are never abbreviated. A terse style that
    // silently shortens a security warning is a style that stops controlling
    // exactly where control matters, so that line is not optional prose.
    //
    // P6.171 put the same clause in `getGuidanceSections` as an UNTAGGED
    // bullet, so it now reaches every session on all three runtimes whatever
    // style is active. The duplication for a `Concise` session is DELIBERATE
    // and not an oversight: the last line below is the fourth sentence of the
    // documented Concise built-in, and deleting it would put our built-in out
    // of conformance with the page it is transcribed from. The guidance bullet
    // is the FLOOR under every style, including a custom one; this line is the
    // documented text of ONE style. They are not the same claim, and the
    // decision is recorded here rather than made silently in either file.
    id: 'concise',
    kind: 'builtin',
    label: 'Concise',
    description: 'Short, direct answers with minimal framing.',
    prompt: [
      'Prefer short, direct answers.',
      'Lead with the result, then include only the context needed to act.',
      'Use lists only when they make the answer easier to scan.',
      'Brevity applies to the REPLY, never to the work: do the engineering as thoroughly as under the Default style.',
      'When the user asks for an explanation or more detail, answer in full.',
      'Always keep error reports, security warnings, and confirmations for destructive actions COMPLETE; never shorten, summarize, or omit them.',
    ].join('\n'),
    keepCodingInstructions: true,
  },
  {
    id: 'explanatory',
    kind: 'builtin',
    label: 'Explanatory',
    description: 'Teach the reasoning and tradeoffs as you go.',
    prompt: [
      'Explain the reasoning behind important choices.',
      'Name tradeoffs and assumptions when they affect the result.',
      'Keep the structure clear without turning simple answers into long essays.',
    ].join('\n'),
    keepCodingInstructions: true,
  },
  {
    id: 'reviewer',
    kind: 'builtin',
    label: 'Reviewer',
    description: 'Prioritize risks, regressions, and verification gaps.',
    prompt: [
      'Use a review-oriented voice.',
      'Lead with bugs, risks, behavioral regressions, or missing tests.',
      'Keep summaries secondary to actionable findings and concrete evidence.',
    ].join('\n'),
    keepCodingInstructions: true,
  },
  // The next two are APPENDED, never inserted: `config.json:outputStyleId`
  // persists raw ids, so renaming or reordering an existing entry would orphan
  // a stored selection into `NO_OUTPUT_STYLE`.
  {
    // `output-styles.md:21` — the documented Proactive built-in. Prompt prose
    // ONLY: it changes initiative, never permission gating — the same line
    // binds it to work "without changing your permission mode", and the
    // untagged safety bullets in `getSafetyAndEngineeringSections` still
    // outrank it because the style block renders after them.
    id: 'proactive',
    kind: 'builtin',
    label: 'Proactive',
    description: 'Execute immediately and prefer action over planning.',
    prompt: [
      'Start executing the requested work immediately.',
      'Make reasonable assumptions for routine decisions instead of pausing to confirm them.',
      'Prefer action over extended planning; keep momentum until the task is done.',
      'This changes initiative only: permission prompts and safety rules still apply unchanged.',
    ].join('\n'),
    keepCodingInstructions: true,
  },
  {
    // `output-styles.md:25` — the documented Learning built-in. The
    // `TODO(human)` marker is carried literally: it is the handoff interface
    // the page names, not prose to paraphrase.
    id: 'learning',
    kind: 'builtin',
    label: 'Learning',
    description: 'Learn by doing: shared insights plus TODO(human) handoffs.',
    prompt: [
      'Work in a collaborative, learn-by-doing mode.',
      'Share brief educational "Insights" about the code and your implementation choices as you work.',
      'Ask the user to contribute small, strategic pieces of code themselves: leave `TODO(human)` markers in the code at those spots for the user to implement.',
      'Keep each TODO(human) handoff small, well-scoped, and clearly described.',
    ].join('\n'),
    keepCodingInstructions: true,
  },
];

const BUILTIN_OUTPUT_STYLE_IDS = new Set(BUILTIN_OUTPUT_STYLE_DEFINITIONS.map(style => style.id));

export function normalizeOutputStyleId(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_OUTPUT_STYLE_ID;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_OUTPUT_STYLE_ID;
}

const OUTPUT_STYLE_SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
/**
 * A `PluginKey` in an id. `pluginKeyFor` builds two base64url segments joined by
 * `.`, but a key is an opaque token elsewhere in this repo, so the shape is
 * validated rather than parsed: path-free, no `:` (the id's own separator), and
 * never leading with a dot so no key can read as a traversal.
 */
const OUTPUT_STYLE_PLUGIN_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export function isValidOutputStyleId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const id = normalizeOutputStyleId(value);
  if (BUILTIN_OUTPUT_STYLE_IDS.has(id)) {
    return true;
  }

  if (id.startsWith(PLUGIN_OUTPUT_STYLE_PREFIX)) {
    const rest = id.slice(PLUGIN_OUTPUT_STYLE_PREFIX.length);
    const separator = rest.lastIndexOf(':');
    if (separator <= 0) return false;
    return OUTPUT_STYLE_PLUGIN_KEY.test(rest.slice(0, separator))
      && OUTPUT_STYLE_SLUG.test(rest.slice(separator + 1));
  }

  if (!id.startsWith(CUSTOM_OUTPUT_STYLE_PREFIX)) {
    return false;
  }

  const slug = id.slice(CUSTOM_OUTPUT_STYLE_PREFIX.length);
  return OUTPUT_STYLE_SLUG.test(slug);
}

/**
 * The selectable id for a plugin-shipped style, or `null` when the plugin key or
 * the style name cannot produce one.
 *
 * `null` is a refusal, not a fallback: a style whose id cannot be built must not
 * be listed, because the picker would offer a selection the prompt builder could
 * never resolve — the declared-but-inert shape.
 */
export function pluginOutputStyleId(pluginKey: string, styleName: string): string | null {
  if (!OUTPUT_STYLE_PLUGIN_KEY.test(pluginKey)) return null;
  const slug = outputStyleSlug(styleName);
  if (!slug) return null;
  return `${PLUGIN_OUTPUT_STYLE_PREFIX}${pluginKey}:${slug}`;
}

/**
 * The slug a style NAME reduces to — the capability-id component, and the tail of
 * {@link pluginOutputStyleId}. Exported so the adapter's capability id and the
 * projected selectable id are derived from one rule.
 */
export function outputStyleNameSlug(styleName: string): string | null {
  return outputStyleSlug(styleName);
}

/**
 * Directories to read, lowest precedence first: user, then the Nessy-owned
 * workspace, then the project chain — but the project only once it is trusted.
 *
 * The selection itself is app-global (`config.json:outputStyleId`). It used to
 * be resolved working-directory-first and ungated, so merely opening a
 * repository that shipped a style with the same id substituted that
 * repository's prose for the one the user picked, and the substitution landed
 * in the system prompt.
 *
 * The project tier is a CHAIN, not one directory (`output-styles.md:55`):
 * every styles directory between the working directory and `projectRoot`,
 * pushed root-first so the working directory lands last and wins name
 * collisions under the overwrite rule in `discoverCustomOutputStyles` —
 * "the one closest to the working directory". Every walked directory sits
 * behind the SAME single `projectTrusted` gate as before.
 */
function outputStyleDirectories(options: OutputStyleRoots): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  const push = (dir: string): void => {
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    dirs.push(resolved);
  };

  push(USER_OUTPUT_STYLES_DIR);

  if (options.workspaceRootPath?.trim()) {
    push(join(options.workspaceRootPath, OUTPUT_STYLES_DIR));
  }

  if (options.projectTrusted === true && options.workingDirectory?.trim()) {
    const cwd = resolve(options.workingDirectory);
    const stopRoot = resolve(options.projectRoot?.trim() || cwd);
    const containment = relative(stopRoot, cwd);
    const escaped = containment === '..'
      || containment.startsWith(`..${sep}`)
      || isAbsolute(containment);
    if (escaped) {
      // A working directory OUTSIDE the declared project root gets no ancestor
      // chain — only its own directory, the pre-walk behaviour. Climbing an
      // unrelated lineage would read prompt prose from directories the trust
      // decision never covered. Same containment rule as `projectAncestors`
      // in `workflows/workflow-loader.ts`.
      push(join(cwd, OUTPUT_STYLES_DIR));
    } else {
      // Nearest-first climb from the working directory to the stop root (or
      // the filesystem root, whichever comes first), then reversed so the
      // root-most directory is pushed first (lowest precedence) and the
      // working directory last (highest — closest-to-cwd wins).
      const chain: string[] = [];
      let current = cwd;
      while (chain.length < MAX_OUTPUT_STYLE_WALK_DEPTH) {
        chain.push(current);
        if (current === stopRoot) break;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
      for (const dir of chain.reverse()) {
        push(join(dir, OUTPUT_STYLES_DIR));
      }
    }
  }

  // P6.239 — the managed tier is pushed at the END, so a same-named managed
  // style overwrites the user's and the project's.
  const managed = managedOutputStylesDir(options);
  if (managed) push(managed);

  return dirs;
}

/**
 * The managed output-style directory for this machine, or `undefined` when the
 * platform has no managed settings location.
 *
 * `managedSystemDir` is a test seam only; production omits it and gets
 * {@link managedSystemDirForPlatform}, so there is one answer to "where is the
 * managed tier" and `native-sources.ts` reads it from the same function.
 */
function managedOutputStylesDir(options: OutputStyleRoots): string | undefined {
  const systemDir = options.managedSystemDir ?? managedSystemDirForPlatform();
  return systemDir ? resolve(join(systemDir, MANAGED_OUTPUT_STYLES_DIRNAME)) : undefined;
}

/**
 * The stop boundary for the project output-style walk, derived from the
 * working directory: the nearest ancestor carrying a `.git` marker — the
 * "repository root" `output-styles.md:55` bounds the walk with. Returns
 * `undefined` when no marker exists, which callers pass through as "walk
 * nothing beyond the working directory".
 *
 * Same `.git` climb as `repositoryRoot` in `workflows/workflow-loader.ts`.
 * Derived here rather than threaded from the server because the server's
 * canonical project path IS the session's (re-bound) working directory —
 * `SessionManager.createCapabilityTurn` re-validates the handle at
 * `managed.workingDirectory` every turn — so it can never name an ancestor of
 * the cwd, and threading it would make the walk a permanent single-directory
 * no-op.
 */
export function outputStyleProjectRootFor(workingDirectory: string | undefined): string | undefined {
  if (!workingDirectory?.trim()) return undefined;
  let current = resolve(workingDirectory);
  for (let depth = 0; depth < MAX_OUTPUT_STYLE_WALK_DEPTH; depth += 1) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * The slug rule, shared by a file name and a plugin capability's style name. A
 * plugin style must slug identically to a user file with the same name, or the
 * two id namespaces would disagree about what "the same style" means.
 */
function outputStyleSlug(value: string): string | null {
  const raw = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return raw.length > 0 ? raw.slice(0, 80) : null;
}

function slugFromFileName(fileName: string): string | null {
  return outputStyleSlug(basename(fileName, extname(fileName)));
}

function titleFromSlug(slug: string): string {
  return slug
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

interface ParsedOutputStyleFile {
  frontmatter: Record<string, string>;
  body: string;
}

function stripFrontmatterQuotes(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * `output-styles.md:45` \u2014 an output style is "a Markdown file: frontmatter for
 * metadata, then the instructions to add to the system prompt". The frontmatter
 * used to be dropped on the floor, which made every documented field inert.
 *
 * Only the scalar subset we honor is read; unknown keys are ignored so a file
 * authored for Claude Code loads here unchanged.
 */
function parseOutputStyleFile(raw: string): ParsedOutputStyleFile {
  const normalized = raw.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);

  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: normalized };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;

    frontmatter[match[1]!.toLowerCase()] = stripFrontmatterQuotes(match[2] ?? '');
  }

  return { frontmatter, body: lines.slice(endIndex + 1).join('\n') };
}

const FRONTMATTER_TRUE = new Set(['true', 'yes', 'on', '1']);
const FRONTMATTER_FALSE = new Set(['false', 'no', 'off', '0']);

/** Returns `undefined` for an absent or unrecognized value so the caller's documented default applies. */
function parseFrontmatterBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;

  const normalized = value.trim().toLowerCase();
  if (FRONTMATTER_TRUE.has(normalized)) return true;
  if (FRONTMATTER_FALSE.has(normalized)) return false;
  return undefined;
}

/**
 * The four documented frontmatter fields (`output-styles.md:87`-`:94`), read for
 * a caller that needs the METADATA without composing a prompt — the plugin
 * adapter, which builds a capability from the same file the prompt builder will
 * later read.
 *
 * Exported so there is exactly one reader of these field names. The adapter
 * having its own would be the shape that shipped two wrong hook fields earlier in
 * this series.
 */
export interface OutputStyleFrontmatter {
  name?: string;
  description?: string;
  keepCodingInstructions?: boolean;
  /**
   * `output-styles.md:94` — "Plugin output styles only: apply this style
   * automatically whenever the plugin is enabled, without requiring users to
   * select it. Overrides the user's `outputStyle` setting."
   *
   * Read so the surface can be REPORTED. Never honoured; see the adapter.
   */
  forceForPlugin?: boolean;
}

export function readOutputStyleFrontmatter(raw: string): OutputStyleFrontmatter {
  const { frontmatter } = parseOutputStyleFile(raw);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  const keepCodingInstructions = parseFrontmatterBoolean(frontmatter['keep-coding-instructions']);
  const forceForPlugin = parseFrontmatterBoolean(frontmatter['force-for-plugin']);
  return {
    ...(name ? { name } : {}),
    ...(description ? { description: plainDescription(description) } : {}),
    ...(keepCodingInstructions === undefined ? {} : { keepCodingInstructions }),
    ...(forceForPlugin === undefined ? {} : { forceForPlugin }),
  };
}

function plainDescription(line: string): string {
  return line
    .replace(/^[-*]\s+/, '')
    .replace(/[`*_#>]/g, '')
    .trim()
    .slice(0, 180);
}

/**
 * Parse one style file into a definition.
 *
 * The SAME reader for a user file and a plugin-shipped one, deliberately: the
 * frontmatter contract is the file's (`output-styles.md:87`-`:94`), not the
 * container's, and a second reader would be a second place for
 * `keep-coding-instructions` to be interpreted differently.
 */
function parseStyleDefinition(
  raw: string,
  options: { id: string; kind: OutputStyleKind; labelFallback: string; path?: string; pluginName?: string },
): OutputStyleDefinition | null {
  const { frontmatter, body } = parseOutputStyleFile(raw);
  const withoutFrontmatter = body.trim();
  if (!withoutFrontmatter) {
    return null;
  }

  const lines = withoutFrontmatter.split(/\r?\n/);
  const firstContentIndex = lines.findIndex(line => line.trim().length > 0);
  if (firstContentIndex === -1) {
    return null;
  }

  let headingLabel: string | undefined;
  let promptStartIndex = firstContentIndex;
  const firstLine = lines[firstContentIndex]!.trim();
  const headingMatch = firstLine.match(/^#\s+(.+)$/);
  if (headingMatch?.[1]?.trim()) {
    headingLabel = headingMatch[1].trim();
    promptStartIndex = firstContentIndex + 1;
  }

  const prompt = lines.slice(promptStartIndex).join('\n').trim();
  if (!prompt) {
    return null;
  }

  const descriptionLine = lines
    .slice(promptStartIndex)
    .find(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#');
    });

  // `output-styles.md:91` — `name` is the "Name of the output style, if not the
  // file name", and `:92` puts `description` in the picker. The leading
  // `# Heading` and first-line heuristics stay as Nessy-only fallbacks so files
  // written before the frontmatter was read keep the labels they had.
  const frontmatterName = frontmatter.name?.trim();
  const frontmatterDescription = frontmatter.description?.trim();
  const description = frontmatterDescription
    ? plainDescription(frontmatterDescription)
    : (descriptionLine ? plainDescription(descriptionLine) : undefined);

  return {
    id: options.id,
    kind: options.kind,
    label: frontmatterName || headingLabel || options.labelFallback,
    ...(description ? { description } : {}),
    ...(options.path ? { path: options.path } : {}),
    ...(options.pluginName ? { pluginName: options.pluginName } : {}),
    prompt,
    // `output-styles.md:93` — the field defaults to `false`, and `:102` spells
    // out the consequence: a custom style leaves out the built-in software
    // engineering instructions "unless `keep-coding-instructions` is set to
    // `true`". Saying nothing therefore means replace, not extend.
    keepCodingInstructions: parseFrontmatterBoolean(frontmatter['keep-coding-instructions']) ?? false,
  };
}

/**
 * Plugin-shipped styles, parsed from content the caller already read.
 *
 * A plugin style is a NAMESPACE of its own (`plugin:<pluginKey>:<slug>`), so it
 * can never shadow — or be shadowed by — a user, workspace or project style with
 * the same name. `force-for-plugin` is deliberately unread here: applying a style
 * the user did not select is the one thing this surface must not do.
 */
function discoverPluginOutputStyles(sources: readonly PluginOutputStyleSource[]): OutputStyleDefinition[] {
  const styles = new Map<string, OutputStyleDefinition>();
  for (const source of sources) {
    if (styles.has(source.id) || !isValidOutputStyleId(source.id)) continue;
    if (source.content.length > MAX_OUTPUT_STYLE_BYTES) continue;
    const slug = source.id.slice(source.id.lastIndexOf(':') + 1);
    const parsed = parseStyleDefinition(source.content, {
      id: source.id,
      kind: 'plugin',
      labelFallback: source.fallbackLabel?.trim() || titleFromSlug(slug),
      ...(source.pluginName ? { pluginName: source.pluginName } : {}),
    });
    if (parsed) styles.set(source.id, parsed);
  }
  return [...styles.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function discoverCustomOutputStyles(options: OutputStyleRoots): OutputStyleDefinition[] {
  const styles = new Map<string, OutputStyleDefinition>();
  // P6.239 — the one tier whose files carry a provenance check. See
  // {@link MANAGED_OUTPUT_STYLES_DIRNAME} for why, and note the check is
  // PER FILE: `managedFileTrustVerdict` demands `isFile()`, so handing it the
  // directory would refuse the whole tier on every machine.
  const managedDir = managedOutputStylesDir(options);

  for (const dir of outputStyleDirectories(options)) {
    if (!existsSync(dir)) continue;
    const managedTier = managedDir !== undefined && dir === managedDir;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;

      const slug = slugFromFileName(entry.name);
      if (!slug) continue;

      const path = join(dir, entry.name);
      // A managed style is un-excludable prose entering the system prompt from a
      // machine-wide root, so a root any local user can write is not the
      // administrator's voice. `'unverifiable-platform'` WITHHOLDS the file
      // rather than trusting it — the direction P3.331 established for the
      // managed instruction file.
      if (managedTier && managedFileTrustVerdict(path) !== 'trusted') continue;
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > MAX_OUTPUT_STYLE_BYTES) continue;

        const parsed = parseStyleDefinition(readFileSync(path, 'utf8'), {
          id: `${CUSTOM_OUTPUT_STYLE_PREFIX}${slug}`,
          kind: 'custom',
          labelFallback: titleFromSlug(slug),
          path,
        });
        if (!parsed) continue;

        // Later directories outrank earlier ones, so a trusted project's file
        // still replaces the workspace's and the user's — the trust grant is
        // what makes that legitimate.
        styles.set(`${CUSTOM_OUTPUT_STYLE_PREFIX}${slug}`, parsed);
      } catch {
        continue;
      }
    }
  }

  return [...styles.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function toOption({
  prompt: _prompt,
  keepCodingInstructions: _keepCodingInstructions,
  ...style
}: OutputStyleDefinition): OutputStyleOption {
  return style;
}

export function listOutputStyles(options: OutputStyleRoots = {}): OutputStyleOption[] {
  return [
    ...BUILTIN_OUTPUT_STYLE_DEFINITIONS.map(toOption),
    ...discoverCustomOutputStyles(options).map(toOption),
    ...discoverPluginOutputStyles(options.pluginStyles ?? []).map(toOption),
  ];
}

function resolveOutputStyle(styleId: string, options: OutputStyleRoots): OutputStyleDefinition | null {
  const normalized = normalizeOutputStyleId(styleId);
  const builtin = BUILTIN_OUTPUT_STYLE_DEFINITIONS.find(style => style.id === normalized);
  if (builtin) {
    return builtin;
  }

  if (normalized.startsWith(PLUGIN_OUTPUT_STYLE_PREFIX)) {
    // A plugin style resolves ONLY from the supplied sources. When the owning
    // plugin has been disabled or uninstalled the id stops resolving, which
    // `NO_OUTPUT_STYLE` reads as "add nothing, subtract nothing" — never as a
    // licence to drop the engineering guidance.
    return discoverPluginOutputStyles(options.pluginStyles ?? [])
      .find(style => style.id === normalized) ?? null;
  }

  return discoverCustomOutputStyles(options).find(style => style.id === normalized) ?? null;
}

/** What a selected style contributes to one system prompt: text to add, and whether anything is subtracted. */
export interface OutputStyleComposition {
  /** Block appended to the system prompt; empty when the style adds no prose. */
  prompt: string;
  /**
   * `output-styles.md:102` — whether the built-in software engineering
   * instructions stay. The prompt builder owns the subtraction; this only
   * reports the style's declaration.
   */
  keepCodingInstructions: boolean;
  /**
   * The resolved style's display label, `''` when the id resolved to nothing.
   * Carried so the per-turn reminder (`output-styles.md:101`) can NAME the
   * active style without re-walking the style directories every turn. A
   * resolved style whose `prompt` is empty (the Default built-in) still
   * reports its label; callers gating the reminder key off `prompt`, which is
   * what actually reached the system prompt.
   */
  label: string;
}

/**
 * An unresolvable id keeps the full prompt. Subtracting guidance because a
 * style could not be found would let a deleted or mistyped style silently
 * change the agent's behavior, so the fallback only ever adds nothing.
 */
const NO_OUTPUT_STYLE: OutputStyleComposition = { prompt: '', keepCodingInstructions: true, label: '' };

export function resolveOutputStyleComposition(
  styleId: string,
  options: OutputStyleRoots = {},
): OutputStyleComposition {
  const style = resolveOutputStyle(styleId, options);
  if (!style) {
    return NO_OUTPUT_STYLE;
  }

  const prompt = style.prompt.trim();
  if (!prompt) {
    return { prompt: '', keepCodingInstructions: style.keepCodingInstructions, label: style.label };
  }

  return {
    prompt: `

## Output Style: ${style.label}

Follow this selected response style unless it conflicts with higher-priority safety, project, or user instructions:

${prompt}
`,
    keepCodingInstructions: style.keepCodingInstructions,
    label: style.label,
  };
}

export function formatOutputStylePrompt(
  styleId: string,
  options: OutputStyleRoots = {},
): string {
  return resolveOutputStyleComposition(styleId, options).prompt;
}

/**
 * `relevance` on a marketplace plugin entry, and the two signals we can decide.
 *
 * Contract: `plugins/relevance.md` § Field reference and `plugins/org.md#recommend-plugins`,
 * both fetched 2026-08-07.
 *
 * `plugins/org.md#recommend-plugins` — "When your administrator has allowlisted the
 * marketplace via the `pluginSuggestionMarketplaces` managed setting, plugins
 * marked as relevant to your current working directory are pinned at the top
 * with a **suggested for this directory** label."
 *
 * `plugins/relevance.md` § `relevance.signals`, the `cwd` row — "Glob patterns
 * matched against the session's working directory. Matched as an absolute path
 * and, when inside a git repository, as a path relative to the repository root.
 * Forward-slash normalized and case-insensitive. Every pattern matches the
 * directory itself and everything under it, so `infra`, `infra/`, and `infra/**`
 * behave identically. This is the only signal that can match at session start,
 * before the first turn. Maximum 10 patterns of 256 characters each."
 *
 * SCOPE, and the one divergence (P6.519, owner decision Q-den 52 = B).
 * Two of the five signals are decided here: `cwd`, and `manifestDeps`.
 *
 * `cli`, `hosts` and `filesRead` stay UNDECIDED and are named as such by
 * `UNMATCHABLE_RELEVANCE_SIGNALS`, because all three test per-session history —
 * shell commands run, URLs seen, files read — that this fork keeps no record of.
 * Option A of that decision (start keeping one) was refused: a per-session log of
 * commands, hostnames and file reads is a privacy and retention posture this fork
 * has never taken. They are parsed-tolerantly and ignored, which is what
 * `plugins/relevance.md`'s own Note asks of a client that does not understand a
 * sub-key, and the surface that shows a suggestion names them so the narrowing is
 * visible rather than inferred.
 *
 * `manifestDeps` is decided because it needs no behavioural record. The page
 * scopes it to "Dependencies declared in package manifests Claude has read this
 * session"; we substitute "the manifest files of the project the session is
 * working in", collected by `relevance-manifests.ts`. That is a STATED
 * divergence: our answer does not depend on what the agent happened to read, so
 * it is stable from session start, and no per-session file record is created.
 * Every documented mechanic of the signal is kept — `file` case-insensitive
 * against the un-normalized path, `pattern` case-sensitive against the contents,
 * both `RegExp` sources of at most 256 characters, at most 10 entries, manifests
 * over 512 KB skipped.
 *
 * The matcher is PURE — it touches no filesystem. The repository root, and the
 * manifests, are passed in by the caller, which already has to resolve the root.
 */

/** Documented caps, `plugins/relevance.md` § Field reference. */
const TOPIC_MAX = 64;
const CWD_PATTERNS_MAX = 10;
const CWD_PATTERN_MAX = 256;
const MANIFEST_DEPS_MAX = 10;
const MANIFEST_REGEXP_SOURCE_MAX = 256;
/**
 * "Manifest files larger than 512 KB are skipped." Applied to the content's
 * length in UTF-16 code units rather than to its byte length: a string of more
 * than 524 288 code units is always more than 512 KB of UTF-8, so the gate never
 * admits a file the byte rule would skip, and the collector applies the real byte
 * gate before reading anyway.
 */
export const MANIFEST_CONTENT_MAX = 512 * 1024;

/** One `manifestDeps` entry: two `RegExp` sources, path then contents. */
export interface PluginRelevanceManifestDepV1 {
  /** Matched case-insensitively against the manifest path, un-normalized. */
  readonly file: string;
  /** Matched case-sensitively against the manifest contents. */
  readonly pattern: string;
}

export interface PluginMarketplaceRelevanceV1 {
  /** `topic` — "Maximum 64 characters." Display-only; never a matcher. */
  readonly topic?: string;
  readonly signals: {
    /** Glob patterns for the session working directory. */
    readonly cwd?: readonly string[];
    /** Dependency probes against the project's own package manifests. */
    readonly manifestDeps?: readonly PluginRelevanceManifestDepV1[];
  };
}

/** The signal a pin names. Two of the five are decidable; see the module note. */
export type PluginRelevanceSignalKind = 'cwd' | 'manifestDeps';

/**
 * The three signals this fork declines to decide, in the page's own spelling, so
 * a surface can name them instead of leaving the narrowing to be inferred.
 */
export const UNMATCHABLE_RELEVANCE_SIGNALS = Object.freeze(
  ['cli', 'hosts', 'filesRead'] as const,
);

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Parse a catalog entry's `relevance` block.
 *
 * TOLERANT by contract: `plugins/relevance.md`'s Note says "Claude Code ignores
 * unknown fields under `relevance` and `relevance.signals` at load time, so
 * older clients continue to load your marketplace" — so an unknown sub-key is
 * never an error, and a newer upstream marketplace must keep parsing here.
 *
 * Returns undefined when the block is absent, is not an object, or declares no
 * `signals` object at all ("At least one signal is required for the plugin to be
 * suggestible").
 */
export function parseMarketplaceRelevance(value: unknown): PluginMarketplaceRelevanceV1 | undefined {
  const block = plainObject(value);
  if (!block) return undefined;
  const signals = plainObject(block.signals);
  if (!signals || Object.keys(signals).length === 0) return undefined;

  const topic = typeof block.topic === 'string' && block.topic.trim().length > 0
    && block.topic.trim().length <= TOPIC_MAX
    ? block.topic.trim()
    : undefined;

  const cwd = Array.isArray(signals.cwd)
    ? signals.cwd
      .filter((pattern): pattern is string =>
        typeof pattern === 'string'
        && pattern.trim().length > 0
        && pattern.trim().length <= CWD_PATTERN_MAX)
      .map(pattern => pattern.trim())
      .slice(0, CWD_PATTERNS_MAX)
    : [];

  const manifestDeps = Array.isArray(signals.manifestDeps)
    ? signals.manifestDeps
      .map(entry => plainObject(entry))
      .map(entry => ({
        file: regexpSource(entry?.file),
        pattern: regexpSource(entry?.pattern),
      }))
      .filter((entry): entry is PluginRelevanceManifestDepV1 =>
        entry.file !== undefined && entry.pattern !== undefined)
      .map(entry => Object.freeze(entry))
      .slice(0, MANIFEST_DEPS_MAX)
    : [];

  return Object.freeze({
    ...(topic ? { topic } : {}),
    signals: Object.freeze({
      ...(cwd.length ? { cwd: Object.freeze(cwd) } : {}),
      ...(manifestDeps.length ? { manifestDeps: Object.freeze(manifestDeps) } : {}),
    }),
  });
}

/**
 * "Both values are JavaScript `RegExp` source strings of at most 256
 * characters." Compilability is NOT checked here — the block must stay tolerant
 * at load time, and an uncompilable source is simply a matcher that never fires.
 */
function regexpSource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MANIFEST_REGEXP_SOURCE_MAX ? trimmed : undefined;
}

/** One manifest the caller has already read for the session's project. */
export interface RelevanceManifestFile {
  /** The path as the host recorded it — NOT separator-normalized. */
  readonly path: string;
  readonly content: string;
}

export interface RelevanceMatchContext {
  /** The session's working directory, absolute. */
  workingDirectory?: string;
  /** The enclosing git repository root, when the working directory is in one. */
  repositoryRoot?: string;
  /** Project manifests for `manifestDeps`; see `relevance-manifests.ts`. */
  manifests?: readonly RelevanceManifestFile[];
}

/**
 * `plugins/relevance.md`'s `cwd` rule, in full.
 *
 * Returns the matched signal so the pin's annotation can name it, and undefined
 * when nothing matches. Two candidate paths are tested — the absolute working
 * directory and, when a repository root is known, the path relative to it — both
 * forward-slash normalized and lowercased.
 */
export function matchCwdSignal(
  relevance: PluginMarketplaceRelevanceV1 | undefined,
  context: RelevanceMatchContext,
): 'cwd' | undefined {
  const patterns = relevance?.signals.cwd;
  if (!patterns?.length) return undefined;
  const candidates = cwdCandidates(context);
  if (candidates.length === 0) return undefined;
  for (const pattern of patterns) {
    const matcher = cwdPatternRegExp(pattern);
    if (!matcher) continue;
    if (candidates.some(candidate => matcher.test(candidate))) return 'cwd';
  }
  return undefined;
}

/**
 * `plugins/relevance.md`'s `manifestDeps` rule, over the manifests the caller
 * supplies.
 *
 * "`file` is a regular expression matched against the manifest file's path as
 * recorded in session state ... and `pattern` is a regular expression matched
 * against that file's contents ... Paths are not separator-normalized for this
 * signal, so Windows paths use backslashes. ... `file` matches
 * case-insensitively. `pattern` is case-sensitive."
 *
 * An uncompilable source is skipped rather than thrown: the entry came from a
 * marketplace, and a bad regular expression there must not break the listing.
 */
export function matchManifestDepsSignal(
  relevance: PluginMarketplaceRelevanceV1 | undefined,
  context: RelevanceMatchContext,
): 'manifestDeps' | undefined {
  const entries = relevance?.signals.manifestDeps;
  const manifests = context.manifests;
  if (!entries?.length || !manifests?.length) return undefined;
  for (const entry of entries) {
    let filePattern: RegExp;
    let contentPattern: RegExp;
    try {
      filePattern = new RegExp(entry.file, 'i');
      contentPattern = new RegExp(entry.pattern);
    } catch {
      continue;
    }
    for (const manifest of manifests) {
      if (manifest.content.length > MANIFEST_CONTENT_MAX) continue;
      if (!filePattern.test(manifest.path)) continue;
      if (contentPattern.test(manifest.content)) return 'manifestDeps';
    }
  }
  return undefined;
}

/**
 * Every signal this fork decides, in the page's own precedence: `cwd` first,
 * because it "is the only signal that can match at session start, before the
 * first turn", then `manifestDeps`. Returns the kind that matched so the pin's
 * annotation can name it.
 */
export function matchRelevanceSignal(
  relevance: PluginMarketplaceRelevanceV1 | undefined,
  context: RelevanceMatchContext,
): PluginRelevanceSignalKind | undefined {
  return matchCwdSignal(relevance, context) ?? matchManifestDepsSignal(relevance, context);
}

function cwdCandidates(context: RelevanceMatchContext): string[] {
  const working = normalizePath(context.workingDirectory);
  if (!working) return [];
  const candidates = [working];
  const root = normalizePath(context.repositoryRoot);
  if (root && (working === root || working.startsWith(`${root}/`))) {
    // "as a path relative to the repository root" — the root itself yields the
    // empty string, which no pattern should match, so it is dropped.
    const relativePath = working === root ? '' : working.slice(root.length + 1);
    if (relativePath) candidates.push(relativePath);
  }
  return candidates;
}

/** Forward-slash normalized, case-insensitive, no trailing separator. */
function normalizePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const slashes = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  return slashes.length > 0 ? slashes.toLowerCase() : '/';
}

/**
 * One `cwd` pattern as a regular expression.
 *
 * "Every pattern matches the directory itself and everything under it, so
 * `infra`, `infra/`, and `infra/**` behave identically." That is implemented by
 * stripping any trailing `/` or `/**` and then testing the pattern body OR the
 * body followed by `/<anything>` — which is what collapses the three spellings
 * onto one answer.
 */
function cwdPatternRegExp(pattern: string): RegExp | undefined {
  const body = pattern.replace(/\\/g, '/').replace(/\/+(\*\*)?\/*$/, '');
  if (!body) return undefined;
  try {
    const source = globSegmentSource(body.toLowerCase());
    return new RegExp(`^(?:${source})(?:/.*)?$`);
  } catch {
    return undefined;
  }
}

/**
 * Glob → regex source for one path pattern. `**` crosses separators, `*` does
 * not, `?` is one non-separator character; every other regex metacharacter is
 * escaped. Written without the `\0` sentinel trick the mode-manager copy uses:
 * a literal NUL in a source file makes plain `grep` skip the whole file, which
 * this repo has paid for more than once.
 *
 * GRANT-GLOB-NEWLINE. `**` -> `.*` stops at a line terminator while `*`/`?` ->
 * `[^/]` cross it; no `s` flag, deliberately. A relevance signal decides no
 * permission — see `config/__tests__/grant-glob-newline-policy.test.ts`.
 */
function globSegmentSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\/]/, match => `\\${match}`);
  }
  return source;
}

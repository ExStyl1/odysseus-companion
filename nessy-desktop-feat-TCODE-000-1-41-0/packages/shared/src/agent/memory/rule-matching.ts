/**
 * Glob matching for a rule's `paths` frontmatter (R28).
 *
 * Contract source: `code.claude.com/docs/en/memory.md`, "Path-specific rules".
 *
 * Two hardening rules on that page are DoS-class, not niceties, and are
 * implemented here exactly as written:
 *
 * - "Each brace group multiplies the number of expanded patterns... To keep
 *   expansion bounded, a rule's whole `paths` list shares one budget of 1,000
 *   expanded patterns and 4 MiB, and patterns without braces don't count against
 *   it. Claude Code uses any pattern that would exceed the budget unexpanded,
 *   and its literal braces match no files." (Before v2.1.217 many brace groups
 *   stalled or crashed the CLI at startup.)
 * - "A pattern with a `[` that can't be read as a bracket expression, such as
 *   `photos [2024/**`, is invalid: it matches nothing, and the rule's other
 *   patterns keep working. To match a literal `[` in a file name, escape it as
 *   `photos \[2024/**`." (Before v2.1.207 one invalid pattern made the Read tool
 *   fail for every file the rule was evaluated against.)
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** "a rule's whole `paths` list shares one budget of 1,000 expanded patterns". */
export const RULE_PATTERN_EXPANSION_LIMIT = 1_000;
/** "…and 4 MiB". */
export const RULE_PATTERN_EXPANSION_BYTE_LIMIT = 4 * 1024 * 1024;

interface BraceGroup {
  start: number;
  end: number;
  body: string;
}

/** The first unescaped, balanced `{…}` group, or `null` when there is none. */
function findBraceGroup(pattern: string): BraceGroup | null {
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') { i += 1; continue; }
    if (char !== '{') continue;

    let depth = 0;
    for (let j = i; j < pattern.length; j += 1) {
      const inner = pattern[j];
      if (inner === '\\') { j += 1; continue; }
      if (inner === '{') depth += 1;
      else if (inner === '}') {
        depth -= 1;
        if (depth === 0) return { start: i, end: j, body: pattern.slice(i + 1, j) };
      }
    }
    return null; // unbalanced `{` — nothing to expand
  }
  return null;
}

/** Split on top-level commas only, so nested groups stay intact. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (char === '\\') { current += char + (body[i + 1] ?? ''); i += 1; continue; }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Fully expand one pattern's brace groups, or `null` when doing so would exceed
 * `limit` expansions — the caller then uses the pattern unexpanded.
 */
function expandBraces(pattern: string, limit: number): string[] | null {
  const group = findBraceGroup(pattern);
  if (!group) return [pattern];

  const out: string[] = [];
  for (const alternative of splitAlternatives(group.body)) {
    const substituted = pattern.slice(0, group.start) + alternative + pattern.slice(group.end + 1);
    const expanded = expandBraces(substituted, limit);
    if (expanded === null) return null;
    for (const value of expanded) {
      if (out.length >= limit) return null;
      out.push(value);
    }
  }
  return out;
}

/**
 * Expand one rule's whole `paths` list under the shared budget.
 *
 * Order is preserved, brace-free patterns are passed through without charging
 * the budget, and a pattern whose expansion would exceed either half of the
 * budget is emitted verbatim — braces included, which is precisely why it then
 * matches no real file.
 */
export function expandRulePatterns(patterns: readonly string[]): string[] {
  const out: string[] = [];
  let usedPatterns = 0;
  let usedBytes = 0;

  for (const pattern of patterns) {
    if (!pattern) continue;
    if (findBraceGroup(pattern) === null) {
      out.push(pattern); // "patterns without braces don't count against it"
      continue;
    }

    const remaining = RULE_PATTERN_EXPANSION_LIMIT - usedPatterns;
    const expanded = remaining > 0 ? expandBraces(pattern, remaining) : null;
    if (expanded === null) {
      out.push(pattern); // over budget → used unexpanded
      continue;
    }

    const bytes = expanded.reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
    if (usedBytes + bytes > RULE_PATTERN_EXPANSION_BYTE_LIMIT) {
      out.push(pattern); // over the 4 MiB half of the same budget
      continue;
    }

    usedPatterns += expanded.length;
    usedBytes += bytes;
    out.push(...expanded);
  }

  return out;
}

const REGEX_SPECIALS = /[.+^$()|\\]/g;

/** Translate one path SEGMENT, or `null` for an unreadable bracket expression. */
function compileSegment(segment: string): string | null {
  let out = '';
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]!;

    if (char === '\\') {
      // The documented escape: `photos \[2024/**` matches a literal `[`.
      const next = segment[i + 1];
      if (next === undefined) return null;
      out += next.replace(REGEX_SPECIALS, '\\$&').replace(/[[\]{}*?-]/g, '\\$&');
      i += 1;
      continue;
    }

    if (char === '*') {
      if (segment[i + 1] === '*') { out += '.*'; i += 1; continue; }
      out += '[^/]*';
      continue;
    }
    if (char === '?') { out += '[^/]'; continue; }

    if (char === '[') {
      const close = findBracketClose(segment, i);
      if (close === -1) return null; // "can't be read as a bracket expression"
      let body = segment.slice(i + 1, close);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      i = close;
      continue;
    }
    if (char === ']') return null; // a close with no open is unreadable too

    out += char.replace(REGEX_SPECIALS, '\\$&').replace(/[{}]/g, '\\$&');
  }
  return out;
}

/** Index of the `]` closing the bracket expression opened at `open`, or -1. */
function findBracketClose(segment: string, open: number): number {
  let i = open + 1;
  if (segment[i] === '!' || segment[i] === '^') i += 1;
  if (segment[i] === ']') i += 1; // a leading `]` is a literal member
  for (; i < segment.length; i += 1) {
    if (segment[i] === '\\') { i += 1; continue; }
    if (segment[i] === ']') return i;
  }
  return -1;
}

const compiledGlobCache = new Map<string, RegExp | null>();

/**
 * Compile one glob into an anchored regex over a slash-separated relative path,
 * or `null` when the pattern is invalid — an invalid pattern MATCHES NOTHING and
 * never throws, so it cannot take the rule's sibling patterns down with it.
 */
export function compileRuleGlob(pattern: string): RegExp | null {
  const cached = compiledGlobCache.get(pattern);
  if (cached !== undefined) return cached;

  const compiled = compileRuleGlobUncached(pattern);
  if (compiledGlobCache.size < 5_000) compiledGlobCache.set(pattern, compiled);
  return compiled;
}

/**
 * GRANT-GLOB-NEWLINE. A trailing `**` -> `.*` stops at a line terminator while
 * the `[^/]`-based arms cross it; no `s` flag, deliberately. Memory rules decide
 * no permission — see `config/__tests__/grant-glob-newline-policy.test.ts`.
 */
function compileRuleGlobUncached(pattern: string): RegExp | null {
  const normalized = pattern.replace(/\\/g, match => match).trim();
  if (!normalized) return null;

  const segments = normalized.replace(/^\.\//, '').split('/');
  let source = '^';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const last = i === segments.length - 1;

    if (segment === '**') {
      // `**` spans any number of segments, INCLUDING zero — `**/*.ts` has to
      // match `a.ts` at the root as well as `src/deep/a.ts`.
      source += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }

    const compiled = compileSegment(segment);
    if (compiled === null) return null;
    source += compiled;
    if (!last) source += '/';
  }

  try {
    return new RegExp(`${source}$`);
  } catch {
    return null;
  }
}

/** Whether any of `patterns` (already expanded) matches the relative path. */
export function matchingRulePatterns(
  patterns: readonly string[],
  relativePath: string,
): string[] {
  const target = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const matched: string[] = [];
  for (const pattern of patterns) {
    const regex = compileRuleGlob(pattern);
    if (regex?.test(target)) matched.push(pattern);
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Per-read activation
// ---------------------------------------------------------------------------

/** One `paths:`-scoped rule, pinned for a capability generation. */
export interface PathScopedRuleDefinition {
  /** Stable per-file identity — the capability record key. */
  key: string;
  /** Absolute path of the rule file itself (for the observability payload). */
  filePath: string;
  /** Root the rule's patterns are written relative to. */
  matchRoot: string;
  /** The raw `paths` list, BEFORE brace expansion. */
  patterns: readonly string[];
  /** Rule body, frontmatter already stripped. */
  body: string;
  /** Documented `memory_type` for `InstructionsLoaded`. */
  memoryType?: 'User' | 'Project' | 'Local' | 'Managed';
}

/** One rule that a specific file read just brought into scope. */
export interface PathScopedRuleActivation {
  rule: PathScopedRuleDefinition;
  body: string;
  /** The file whose read triggered it (`trigger_file_path`). */
  triggerFilePath: string;
  /** The patterns that matched (`globs`). */
  matchedPatterns: string[];
}

const expandedPatternCache = new Map<string, string[]>();

function expandedPatternsFor(rule: PathScopedRuleDefinition): string[] {
  const cacheKey = rule.patterns.join('\u0000');
  const cached = expandedPatternCache.get(cacheKey);
  if (cached) return cached;
  const expanded = expandRulePatterns(rule.patterns);
  if (expandedPatternCache.size < 500) expandedPatternCache.set(cacheKey, expanded);
  return expanded;
}

/** Test seam: drop the memoized expansions/compilations. */
export function clearRuleMatchingCaches(): void {
  expandedPatternCache.clear();
  compiledGlobCache.clear();
}

/**
 * Every rule brought into scope by reading `filePaths`.
 *
 * The pattern is matched against the FILE, relative to the rule's own root —
 * never against the working directory, which is the bug this replaces. When the
 * literal path falls outside that root, the resolved paths are tried too, so
 * matching still works "when Claude reaches a file through a symlinked path to
 * the project directory, for example in a symlinked checkout" (v2.1.198).
 */
export function collectPathScopedRuleActivations(
  rules: readonly PathScopedRuleDefinition[],
  filePaths: readonly string[],
): PathScopedRuleActivation[] {
  if (rules.length === 0 || filePaths.length === 0) return [];

  const activations: PathScopedRuleActivation[] = [];
  const activated = new Set<string>();

  for (const filePath of filePaths) {
    for (const rule of rules) {
      if (activated.has(rule.key)) continue;
      if (rule.patterns.length === 0) continue;

      const candidates = relativeCandidates(rule.matchRoot, filePath);
      if (candidates.length === 0) continue;

      const expanded = expandedPatternsFor(rule);
      let matched: string[] = [];
      for (const candidate of candidates) {
        matched = matchingRulePatterns(expanded, candidate);
        if (matched.length > 0) break;
      }
      if (matched.length === 0) continue;

      activated.add(rule.key);
      activations.push({ rule, body: rule.body, triggerFilePath: filePath, matchedPatterns: matched });
    }
  }

  return activations;
}

function escapesRoot(relativePath: string): boolean {
  return relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || relativePath.startsWith('../')
    || isAbsolute(relativePath)
    || relativePath === '';
}

/** The path(s) to match `filePath` under, relative to `matchRoot`. */
function relativeCandidates(matchRoot: string, filePath: string): string[] {
  const root = resolve(matchRoot);
  const target = resolve(filePath);
  const direct = relative(root, target);
  if (!escapesRoot(direct)) return [direct];

  // Symlinked checkout: resolve both ends before giving up. `realpathSync` on
  // the file itself fails for a not-yet-created Write target, so the directory
  // is resolved instead and the basename re-attached.
  try {
    const realRoot = realpathSync(root);
    const realTarget = join(realpathSync(dirname(target)), basename(target));
    const resolved = relative(realRoot, realTarget);
    return escapesRoot(resolved) ? [] : [resolved];
  } catch {
    return [];
  }
}

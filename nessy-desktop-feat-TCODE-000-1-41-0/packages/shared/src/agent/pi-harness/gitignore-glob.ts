/**
 * Gitignore-style glob matching for Claude Read/Edit path rules
 * (permissions.md § Read and Edit, re-fetched 2026-07-26).
 *
 * Documented subset only: `*` and `?` within a path segment, `**` across
 * segments. Character classes are NOT documented rule syntax, so `[` is a
 * literal character. Pure string semantics — anchor resolution, path
 * canonicalization, and the symlink pair live in the caller
 * (`permission-dsl.ts`).
 */

const SEGMENT_SPECIALS = /[.+^${}()|[\]\\]/g

function segmentToRegExp(segment: string): RegExp {
  const source = segment
    .replace(SEGMENT_SPECIALS, '\\$&')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
  return new RegExp(`^${source}$`, 'u')
}

function segmentsMatch(pattern: readonly string[], path: readonly string[], patternIndex: number, pathIndex: number): boolean {
  if (patternIndex === pattern.length) return pathIndex === path.length
  const segment = pattern[patternIndex]!
  if (segment === '**') {
    // `**` spans zero or more segments; spanning to the very end also lets a
    // trailing `/**` match the named directory itself.
    for (let next = pathIndex; next <= path.length; next++) {
      if (segmentsMatch(pattern, path, patternIndex + 1, next)) return true
    }
    return false
  }
  if (pathIndex === path.length) return false
  if (!segmentToRegExp(segment).test(path[pathIndex]!)) return false
  return segmentsMatch(pattern, path, patternIndex + 1, pathIndex + 1)
}

function splitSegments(value: string): string[] {
  return value.split('/').filter(segment => segment.length > 0 && segment !== '.')
}

/**
 * Matches one gitignore-style pattern against a `/`-separated relative path.
 *
 * `anyDepth: true` is the deny/ask depth rule — the pattern floats to any
 * directory level (an implicit `**​/` prefix). `false` anchors the pattern to
 * the relative root (the allow-rule depth). Independently of `anyDepth`, a
 * literal bare filename (no `/`, no wildcard) matches at any depth in every
 * rule type: permissions.md — "Bare filenames follow gitignore semantics and
 * match at any depth, so `Read(.env)` and `Read(**​/.env)` are equivalent."
 *
 * `bareLiteralFloat: false` turns that last rule off, for the one caller whose
 * documented semantics are NOT gitignore's: `Cd` patterns are "anchored to the
 * whole directory path rather than gitignore-style" (permissions.md § Cd), so
 * `Cd(node_modules)` names the one directory beside the anchor and only
 * `Cd(**​/node_modules)` floats. Every other caller keeps the float, which is
 * why the option defaults to on rather than being required at each call site.
 */
export function matchGitignoreGlob(
  pattern: string,
  relPath: string,
  opts: { anyDepth: boolean; bareLiteralFloat?: boolean },
): boolean {
  const bareLiteralFilename = opts.bareLiteralFloat !== false
    && !pattern.includes('/')
    && !/[*?]/.test(pattern)
  const patternSegments = splitSegments(pattern)
  if ((opts.anyDepth || bareLiteralFilename) && patternSegments[0] !== '**') {
    patternSegments.unshift('**')
  }
  return segmentsMatch(patternSegments, splitSegments(relPath), 0, 0)
}

/**
 * Whether a relative pattern is eligible for the deny/ask depth float
 * (permissions.md): "A relative pattern with a single directory segment, such
 * as `src/**`, matches at different depths depending on the rule type...
 * Every other pattern shape matches at the same depth in every rule type."
 * Slash-free patterns (`.env`, `*.pem`) follow the same gitignore float.
 */
export function isDepthFloatEligible(pattern: string): boolean {
  if (!pattern.includes('/')) return true
  const segments = splitSegments(pattern)
  return segments.length === 2 && segments[0] !== '**' && segments[1] === '**'
}

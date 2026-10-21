/**
 * What a source slug may be when it arrives from outside this process.
 *
 * `enabledSourceSlugs` is a bare `z.array(z.string())` on every wire that
 * carries it — the `spawn_session` tool schema the MODEL fills in
 * (`agent/spawn-session-tool.ts`, `session-tools-core/src/tool-defs.ts`), the
 * `CreateSessionRequest` DTO, and the workspace defaults a stored session
 * replays. No entry is checked anywhere on the way in, and the value is used as
 * a PATH SEGMENT: `getSourcePath` is `join(<workspace>/sources, slug)`.
 *
 * Measured on HEAD before this module existed, through the real
 * `permissionsConfigCache.getMergedConfig`, with `['real']` and `[]` as the
 * positive and negative controls in the same run:
 *
 *   - `['']`                loaded the sources directory's own `permissions.json`
 *   - `['   ']`             loaded a `permissions.json` under a three-space name
 *   - `['nested/deep']`     loaded a grandchild of the sources directory
 *   - `['..', '..', tmp]`   loaded a `permissions.json` from OUTSIDE the
 *                           workspace entirely, and its `allowedBashPatterns`
 *                           landed in the merged `readOnlyBashPatterns`
 *   - `['real','real']`     pushed the same source's rules TWICE
 *
 * The last two are why this is not only the empty-slug nuisance the row names.
 * Source configs are ADDITIVE — they may only widen — so a slug the model chose
 * can name any `permissions.json` on the host and have its allows merged in, and
 * a repeated slug spends the DSL rule cap twice on one source.
 *
 * ## The rule, and what it deliberately is NOT
 *
 * A slug is accepted when it can only ever name a DIRECT CHILD of the sources
 * directory. That is a containment test, not a spelling test: it rejects the
 * blank, the separators and the dot segments, and accepts every other directory
 * name a host can hold.
 *
 * It is deliberately NOT `session-tools-core`'s `SLUG_REGEX`
 * (lowercase-alphanumeric-with-hyphens). `generateSourceSlug` does produce that
 * shape, but `loadWorkspaceSources` enumerates DIRECTORY NAMES, so an
 * externally-authored source folder carries its own name through verbatim.
 * A spelling rule would disable working sources; a containment rule cannot.
 *
 * And nothing here REWRITES a slug. Trimming `' real'` into `'real'` would be
 * the P2.190 mistake one layer up: normalizing distinct inputs onto each other
 * at a boundary is what made an authored-empty list indistinguishable from an
 * absent one. An entry is either usable as written or reported as unusable.
 *
 * Kept free of `node:path` and of every other import on purpose: this is the
 * shared DEFINITION, and both separators are rejected on every platform so a
 * slug means the same thing on a POSIX host and a Windows one.
 */

/** Why one entry of a wire-supplied slug list cannot be used. */
export type SourceSlugRejectionReason =
  /** Empty or whitespace only — it names the sources directory itself. */
  | 'blank'
  /** Holds a path separator or is a dot segment — it names something other than a direct child. */
  | 'not-contained'
  /** Holds a control character, NUL included — unusable as a path segment. */
  | 'control-character'
  /** An entry already accepted earlier in the same list. */
  | 'duplicate'

/**
 * One rejected entry, by POSITION and reason — never by value.
 *
 * The same split `MergedPermissionsConfig.permissionDslDiagnostics` makes: a
 * rejected slug is externally authored text that may be a path, so only the
 * closed union and the index are safe to carry toward anything that renders.
 * The raw value stays on the debug line at the call site.
 */
export interface RejectedSourceSlug {
  readonly index: number
  readonly reason: SourceSlugRejectionReason
}

export interface SourceSlugPartition {
  /** The entries that may be used, in their declared order, duplicates removed. */
  readonly accepted: readonly string[]
  /** Every entry that may not, in declared order. Empty for a clean list. */
  readonly rejected: readonly RejectedSourceSlug[]
}

/** C0 controls, NUL included, plus DEL. Written as escapes: a literal NUL here would be invisible to grep (AGENTS.md). */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * Why `slug` may not be used as a source slug, or `undefined` if it may.
 *
 * Order of the checks decides only which REASON a doubly-bad entry reports; a
 * slug failing any of them is rejected either way.
 */
export function classifySourceSlug(slug: string): SourceSlugRejectionReason | undefined {
  if (slug.trim().length === 0) return 'blank'
  if (CONTROL_CHARACTERS.test(slug)) return 'control-character'
  if (slug.includes('/') || slug.includes('\\')) return 'not-contained'
  if (slug === '.' || slug === '..') return 'not-contained'
  return undefined
}

/**
 * Split a wire-supplied slug list into what may be used and what may not.
 *
 * Declaration ORDER is preserved, because it is a policy input everywhere this
 * feeds: the permissions merge composes source layers in the order it visits
 * them, and two sources naming one tool resolve by who is visited first.
 */
export function partitionSourceSlugs(slugs: readonly string[] | undefined): SourceSlugPartition {
  if (!slugs || slugs.length === 0) return { accepted: [], rejected: [] }

  const accepted: string[] = []
  const rejected: RejectedSourceSlug[] = []
  const seen = new Set<string>()

  for (const [index, slug] of slugs.entries()) {
    const reason = classifySourceSlug(slug)
    if (reason !== undefined) {
      rejected.push({ index, reason })
      continue
    }
    if (seen.has(slug)) {
      rejected.push({ index, reason: 'duplicate' })
      continue
    }
    seen.add(slug)
    accepted.push(slug)
  }

  return { accepted, rejected }
}
